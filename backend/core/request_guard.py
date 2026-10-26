"""Reject scanner paths before static-file lookup, sessions or database work."""
from collections import OrderedDict, deque
import logging
import re
import threading
import time
from types import SimpleNamespace
from urllib.parse import unquote

logger = logging.getLogger(__name__)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_PROBE = re.compile(
    r"(?:^|/)(?:\.env(?:[./_-]|$)|\.git(?:/|$)|\.svn(?:/|$)|\.ssh(?:/|$)|"
    r"wp-admin(?:/|$)|wp-content(?:/|$)|wp-includes(?:/|$)|xmlrpc\.php$|"
    r"cgi-bin(?:/|$)|proc/self(?:/|$)|etc/(?:passwd|shadow)(?:/|$)|"
    r"@fs(?:/|$)|__vite_rsc_findSourceMapURL$|api/(?:fs/read|system/fileView)(?:/|$))|"
    r"\.(?:php[0-9]?|asp|aspx|jsp)(?:/|$)", re.I)
_LOGIN = {"/moderator-login/", "/accounts/login/", "/admin/login/"}
_SMALL_FORMS = _LOGIN | {"/ajax/musiq/request-music/", "/api/musiq/post-song/", "/api/musiq/post_song/"}


def suspicious_path(path):
    if len(path) > 4096:
        return "path-length"
    for _ in range(4):
        if _CONTROL.search(path) or "\\" in path:
            return "path-encoding"
        if any(part == ".." or ":" in part for part in path.split("/")):
            return "path-traversal"
        if _PROBE.search(path):
            return "scanner-path"
        decoded = unquote(path)
        if decoded == path:
            return ""
        path = decoded
    return "nested-path-encoding"


class RequestGuard:
    def __init__(self, application):
        self.application = application
        self.lock = threading.Lock()
        self.probes = OrderedDict()
        self.logins = OrderedDict()
        self.log_window = 0.0
        self.log_count = 0

    @staticmethod
    def _client(environ):
        from core.user_manager import get_client_ip
        return get_client_ip(SimpleNamespace(META=environ)) or environ.get("REMOTE_ADDR", "")

    def _record_probe(self, environ, reason):
        client = self._client(environ)
        now = time.monotonic()
        with self.lock:
            key = (client, reason)
            last, count = self.probes.pop(key, (0, 0))
            count += 1
            if now - self.log_window >= 60:
                self.log_window, self.log_count = now, 0
            report = (not last or now - last >= 60) and self.log_count < 20
            if report:
                last = now
                self.log_count += 1
            self.probes[key] = (last, count)
            while len(self.probes) > 4096:
                self.probes.popitem(last=False)
        if report:
            logger.info("Blocked suspicious request: category=%s client=%s attempts=%s", reason, client, count)

    def _login_allowed(self, environ):
        client, now = self._client(environ), time.monotonic()
        with self.lock:
            recent = self.logins.pop(client, deque())
            while recent and now - recent[0] >= 60:
                recent.popleft()
            allowed = len(recent) < 20
            if allowed:
                recent.append(now)
            self.logins[client] = recent
            while len(self.logins) > 4096:
                self.logins.popitem(last=False)
            return allowed

    @staticmethod
    def _reply(start_response, status, message, extra=()):
        body = message.encode("utf-8")
        start_response(status, [("Content-Type", "text/plain; charset=utf-8"),
                                ("Content-Length", str(len(body))),
                                ("Cache-Control", "no-store"),
                                ("X-Content-Type-Options", "nosniff"), *extra])
        return [body]

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        reason = suspicious_path(path)
        if reason:
            self._record_probe(environ, reason)
            return self._reply(start_response, "404 Not Found", "Not found.")
        if path in _SMALL_FORMS and environ.get("REQUEST_METHOD") == "POST":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
            except ValueError:
                return self._reply(start_response, "400 Bad Request", "Invalid request length.")
            if length < 0 or length > 65536:
                return self._reply(start_response, "413 Payload Too Large", "This form submission is too large.")
            if path in _LOGIN and not self._login_allowed(environ):
                return self._reply(start_response, "429 Too Many Requests",
                                   "Too many login attempts. Please try again in a minute.",
                                   [("Retry-After", "60")])
        return self.application(environ, start_response)


def guarded_static_application(application):
    from django.contrib.staticfiles.handlers import StaticFilesHandler
    return RequestGuard(StaticFilesHandler(application))
