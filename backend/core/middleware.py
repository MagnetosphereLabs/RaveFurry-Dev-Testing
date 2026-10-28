"""Runtime-only FURATIC middleware for bans, IP screening, and After Hours gating."""
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect
import logging
import os
import threading

from core import audit_log, ip_screening, redis, site_mode, user_manager
from core.util import strtobool
from redis.exceptions import RedisError

from django.db import DatabaseError, OperationalError, close_old_connections, connections

logger = logging.getLogger(__name__)

# Leave PostgreSQL capacity for playback and recovery even with 160 HTTP workers.
# Waiting requests have not opened a database connection; static serving and
# the health endpoint do not consume these slots.
_DATABASE_REQUEST_SLOTS = threading.BoundedSemaphore(80)

_BAN_ALWAYS_ALLOWED_PREFIXES = (
    "/static/",
    "/favicon.ico",
)

_MODERATOR_RECOVERY_PREFIXES = (
    "/admin/",
    "/moderator/",
    "/moderator-login/",
    "/api/moderator/",
    "/accounts/",
    "/login/",
    "/logout/",
    "/logged-in/",
)

_ALLOWED_PREFIXES = (
    "/afterhours/",
    "/song-artwork/",
    "/admin/",
    "/moderator/",
    "/moderator-login/",
    "/api/moderator/",
    "/api/site-mode/",
    "/accounts/",
    "/login/",
    "/logout/",
    "/logged-in/",
    "/static/",
    "/favicon.ico",
)


def _can_bypass_ban(path, request) -> bool:
    if path.startswith(_BAN_ALWAYS_ALLOWED_PREFIXES):
        return True
    if path.startswith(_MODERATOR_RECOVERY_PREFIXES) and user_manager.can_moderate(
        getattr(request, "user", None)
    ):
        return True
    return False


def _ban_response(reason: str = "", codename: str = "Unknown") -> HttpResponse:
    if reason in {"api", "blocklist"}:
        message = (
            'Your connection to FURATIC has been blocked due to potential VPN usage. '
            'Please disable your VPN or use a device that doesn\'t have a VPN enabled. '
            'If you believe this is a mistake or live in a region that requires you to use a VPN, '
            'please reach out to an in-game staff member. They can temporarily whitelist you for '
            f'the duration of this event. Codename: <strong>{codename}</strong>'
        )
    else:
        message = (
            'You have been banned by the FURATIC moderation team. '
            '<a href="APPEAL_URL_PLACEHOLDER">Visit this link to appeal</a> and '
            '<a href="GUIDELINES_URL_PLACEHOLDER">review our guidelines</a>. '
            f'Codename: <strong>{codename}</strong>'
        )

    return HttpResponse(message, status=403)

class DatabaseConnectionCleanupMiddleware:
    """Close per-request DB connections aggressively.

    This app uses frequent polling endpoints. In ASGI/debug mode, letting
    request threads keep DB connections around can exhaust PostgreSQL slots.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/_healthz/":
            recovery_reason = ""
            try:
                failed = redis.connection.get("playback_worker_failed")
                if failed is not None and strtobool(failed):
                    recovery_reason = "playback worker failed"
            except (RedisError, ValueError) as error:
                logger.warning("runtime health check failed: %s", error)
                recovery_reason = "runtime health unavailable"
            if recovery_reason:
                if os.name == "nt":
                    from core.musiq import windows_player  # pylint: disable=import-outside-toplevel

                    if windows_player.recovery_would_interrupt_playback():
                        return HttpResponse(
                            "recovery deferred while media is active", content_type="text/plain"
                        )
                response = HttpResponse(recovery_reason, status=503, content_type="text/plain")
                if recovery_reason == "playback worker failed":
                    response["X-Furatic-Recovery"] = "playback-worker-failed"
                return response
            return HttpResponse("ok", content_type="text/plain")

        # Bound the admission wait. Waiting indefinitely can consume every
        # Waitress thread, including the one needed to answer health checks.
        if not _DATABASE_REQUEST_SLOTS.acquire(timeout=2.0):
            response = HttpResponse("The server is busy. Please retry shortly.", status=503)
            response["Retry-After"] = "1"
            return response
        try:
            close_old_connections()
            return self.get_response(request)
        finally:
            try:
                connections.close_all()
            finally:
                _DATABASE_REQUEST_SLOTS.release()

    def process_exception(self, request, exception):
        # Django converts view exceptions to responses before outer __call__
        # handlers run; this is the correct hook for recoverable DB failures.
        if isinstance(exception, (OperationalError, DatabaseError)):
            logger.warning("database unavailable while handling %s %s: %s",
                           request.method, request.path, exception)
            connections.close_all()
            response = HttpResponse("FURATIC is recovering its local database connection. Please retry shortly.", status=503)
            response["Retry-After"] = "1"
            return response
        return None

class ClientIpBanMiddleware:
    """Resolve the real client IP, log requests, and block banned traffic."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.client_ip = user_manager.get_client_ip(request)
        path = request.path
        # Public rendering snapshots do not need a database identity lookup.
        # Keep all IP screening and resolve identity for blocked/audited requests.
        features_only = request.method == "GET" and path == "/visualizer/features.json"
        lightweight = features_only or path.startswith("/song-artwork/") or path in {"/api/site-mode/", "/visualizer/features/"}
        identity = None if lightweight else user_manager.client_identity(request)
        screening = None

        if request.client_ip and user_manager.is_banned_ip(request.client_ip):
            screening = {
                "blocked": True,
                "reason": "manual-ban",
                "cached": True,
                "newlyBlocked": False,
            }
        elif request.client_ip and user_manager.is_whitelisted_ip(request.client_ip):
            screening = {
                "blocked": False,
                "reason": "whitelist",
                "cached": True,
                "newlyBlocked": False,
            }
        elif request.client_ip:
            screening = ip_screening.evaluate_ip(
                request.client_ip,
                allow_api=not site_mode.is_afterhours(),
            )
            if screening.get("blocked") and screening.get("newlyBlocked"):
                if identity is None:
                    identity = user_manager.client_identity(request)
                audit_log.append(
                    "ip_screen_block",
                    request=request,
                    target=request.client_ip,
                    metadata={
                        "reason": screening.get("reason", ""),
                        "source": screening.get("source", {}),
                        "api": screening.get("api", {}),
                    },
                )

        if screening and screening.get("blocked"):
            if identity is None:
                identity = user_manager.client_identity(request)
            if _can_bypass_ban(path, request):
                response = self.get_response(request)
            else:
                response = _ban_response(screening.get("reason", ""), identity.codename if identity else "Unknown")
        else:
            response = self.get_response(request)

        # Avoid thousands of console/file writes for successful background polls.
        # All failures, bans, and ordinary site requests retain their existing logs.
        quiet_poll = path in {
            "/visualizer/features.json", "/api/site-mode/", "/api/notifications/",
            "/ajax/musiq/state/", "/ajax/musiq/own-song-state/",
            "/ajax/musiq/played-history/", "/api/moderator/state/",
            "/afterhours/top-songs/", "/afterhours/history/",
        }
        quiet_poll = quiet_poll or path.startswith("/song-artwork/")
        if not quiet_poll or response.status_code >= 400:
            logger.info(
                "HTTP %s %s %s [%s]",
                request.method,
                request.get_full_path(),
                response.status_code,
                request.client_ip or request.META.get("REMOTE_ADDR", ""),
            )
        if getattr(request, "furatic_set_browser_cookie", False):
            response.set_cookie(user_manager.CLIENT_TOKEN_COOKIE, request.furatic_browser_token, max_age=60 * 60 * 24 * 365 * 2, secure=request.is_secure(), httponly=True, samesite="Lax")
        return response


class AfterHoursModeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path

        if site_mode.is_afterhours() and not path.startswith(_ALLOWED_PREFIXES):
            if path.startswith("/ajax/") or path.startswith("/api/"):
                response = JsonResponse({
                    "siteMode": "afterhours", "redirect": "/afterhours/",
                    "message": "The event has ended. Opening After Hours.",
                    "notifications": [], "songs": [], "myVotes": {}, "currentSongQueueKey": None,
                    "musiq": {"currentSong": None, "songQueue": [], "autoQueue": [],
                              "siteMode": "afterhours", "progress": 0, "totalTimeFormatted": "00:00"},
                }, status=200 if request.method in {"GET", "HEAD"} else 409)
                response["X-Furatic-Site-Mode"] = "afterhours"
                response["Cache-Control"] = "no-store"
                # An expected mode transition is handled, not a server incident.
                response._has_been_logged = True
                return response
            return redirect("afterhours")

        return self.get_response(request)


