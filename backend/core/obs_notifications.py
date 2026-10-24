"""Optional, read-only OBS vote achievements, independent of playback/rendering.

The bounded event ledger and announcement cooldowns live on disk, not in Redis
or a browser tab, so planned web restarts cannot replay achievements. Only the
small public message file is read by the isolated visualizer companion.
"""
from __future__ import annotations

from collections import defaultdict
import datetime
import hashlib
import json
import logging
from pathlib import Path
import threading
import time
import uuid

HOUR = 3600
DAY = 24 * HOUR
DISPLAY_SECONDS = 14
COOLDOWN = 60
HOURLY_LIMIT = 6
MAX_PLAYS = 2048
STATE_NAME = "obs_vote_notifications_state.json"
MESSAGE_NAME = "obs_vote_notification.json"
LOGGER = logging.getLogger(__name__)
_thread = None
_lock = threading.Lock()
_stop = threading.Event()


class Director:
    """Deterministic scheduler. No timers, I/O, database writes, or message queue."""

    def __init__(self, state=None):
        self.state = state if isinstance(state, dict) and state.get("version") == 1 else {}
        # A restart/reconnection establishes a baseline; it isn't a new vote.
        self.rebase = True

    def _new_event(self, now, marker):
        self.state = {
            "version": 1, "event": uuid.uuid4().hex, "start": marker or now,
            "marker": marker, "mode": "event", "plays": {}, "current": None,
            "watermarks": [2, 2, 2], "sent": [], "lastReminder": 0,
            "active": None, "pending": None,
        }
        self.rebase = True

    def update(self, now, mode, marker, rows, current, recent_votes, *, enabled=True, skip_at=-2):
        state = self.state
        if (not state or now < state["start"] or now - state["start"] >= DAY
                or (mode == "event" and (state["mode"] == "afterhours"
                    or (marker and marker > state.get("marker", 0))))):
            # A fresh installation can recover the current event's existing
            # played songs. Normal restarts always reuse the saved start time.
            start = marker if marker and 0 <= now - marker < DAY else 0
            if not state and not start:
                start = min((row["at"] for row in rows if 0 <= now - row["at"] < DAY), default=now)
            self._new_event(now, start)
            self.state["marker"] = marker
            state = self.state
        state["mode"] = mode
        state["sent"] = [at for at in state["sent"] if 0 <= now - at < HOUR]
        plays = state["plays"]
        for row in rows:
            if state["start"] <= row["at"] <= now or current and row["id"] == current["id"]:
                plays[row["id"]] = {key: row[key] for key in ("key", "votes", "at")}
        # Bound both time and population, even if an installation runs for days.
        state["plays"] = plays = dict(sorted(
            ((key, row) for key, row in plays.items() if now - row["at"] < DAY),
            key=lambda item: item[1]["at"],
        )[-MAX_PLAYS:])
        totals = defaultdict(int)
        for row in plays.values():
            totals[row["key"]] += row["votes"]

        prior = state["current"]
        same = bool(current and prior and current["id"] == prior["id"])
        if not same:
            state["pending"] = None
            state["active"] = None
            state["current"] = ({
                "id": current["id"], "votes": current["votes"], "entered": now,
                "peak": current["votes"], "notices": 0, "warned": False,
                "bestRank": 4, "announcedScore": 0,
            } if current else None)
        watched = state["current"]
        score = totals.get(current["key"], 0) if current else 0
        rank = 1 + sum(value > score for value in totals.values())
        unique = sum(value == score for value in totals.values()) == 1
        available = (mode in ("event", "closing") and enabled and current is not None
                     and current["votes"] > skip_at)
        pending = state["pending"]
        if same and not self.rebase and available:
            votes = current["votes"]
            if votes > watched["votes"] and votes > watched["peak"]:
                if (votes >= 3 and unique and rank <= 3
                        and score > state["watermarks"][rank - 1]
                        and (rank < watched["bestRank"] or
                             rank == 1 and score > watched["announcedScore"])):
                    # One slot coalesces successive votes; never build a backlog.
                    pending = {"kind": "rank", "at": now, "score": score, "rank": rank}
            elif (votes < watched["votes"] and watched["peak"] > 0
                  and votes <= 0 and not watched["warned"]):
                pending = {"kind": "risk", "at": now}
        if watched:
            watched["votes"] = current["votes"]
            watched["peak"] = max(watched["peak"], current["votes"])
        if self.rebase:
            pending = None
            self.rebase = False
        if pending and (not available or now - pending["at"] > 90):
            pending = None
        if pending and pending["kind"] == "rank" and (
                not unique or rank != pending["rank"] or score < pending["score"]):
            pending = None
        if pending and pending["kind"] == "risk" and current["votes"] > 0:
            pending = None
        if not available:
            pending = None
            state["active"] = None
        active = state["active"]
        if active and (now >= active["expiresAt"] or
                active["kind"] == "rank" and (not unique or rank != active["rank"] or score < active["score"]) or
                active["kind"] == "risk" and current["votes"] > 0):
            state["active"] = None

        allowed = (available and not state["active"] and len(state["sent"]) < HOURLY_LIMIT
                   and (not state["sent"] or now - state["sent"][-1] >= COOLDOWN)
                   and now - watched["entered"] >= 8 and watched["notices"] < 2)
        message = None
        if allowed and pending and now - pending["at"] >= (2 if pending["kind"] == "risk" else 5):
            if pending["kind"] == "risk":
                votes = current["votes"]
                vote_label = "vote" if abs(votes) == 1 else "votes"
                message = {"kind": "risk", "headline": "Cast your vote!",
                           "detail": f"This song has {votes} {vote_label}. It skips at {skip_at}.",
                           "footer": "Cast your vote and add music at"}
                watched["warned"] = True
            else:
                headline = ["A new crowd favorite!", "Making a move!", "Into the top three!"][rank - 1]
                detail = f"Song #{rank} in today's event so far · {score} votes."
                message = {"kind": "rank", "rank": rank, "score": score,
                           "headline": headline,
                           "detail": detail, "footer": "Cast your vote and add music at"}
                state["watermarks"][rank - 1] = score
                watched["bestRank"] = min(watched["bestRank"], rank)
                watched["announcedScore"] = score
            pending = None
        elif (allowed and not pending and now - state["start"] >= HOUR
              and now - state["lastReminder"] >= HOUR and recent_votes <= 7):
            message = {"kind": "reminder", "headline": "Don't forget to vote!",
                       "detail": "Your favorite music can make today's top charts.",
                       "footer": "Cast your vote and add music at"}
            state["lastReminder"] = now
        if message:
            message.update(id=uuid.uuid4().hex, createdAt=now, expiresAt=now + DISPLAY_SECONDS,
                           title=current["title"] if message["kind"] != "reminder" else "",
                           artist=current["artist"] if message["kind"] != "reminder" else "")
            state["active"] = message
            state["sent"].append(now)
            watched["notices"] += 1
        state["pending"] = pending
        return state["active"]


def _row(song, at):
    from core.musiq.display_name import clean_display_names
    artist, title = clean_display_names(song["artist"], song["title"])
    identity = song["external_url"] or f"{artist}\n{title}"
    return {"id": str(song["occurrence_id"]),
            "key": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
            "votes": int(song["votes"]), "at": at.timestamp(),
            "artist": artist[:180], "title": title[:240]}


def _event_marker(now):
    from core import models
    # Read the real persisted mode transitions. Repeated 'event' clicks and
    # closing/reopening requests must not start a new achievement session.
    entries = models.AuditEntry.objects.filter(
        action="moderator_set_site_mode", created__gte=now - datetime.timedelta(hours=24),
    ).order_by("-created").values("target", "created")[:128]
    start = 0
    for entry in entries:
        if entry["target"] == "afterhours":
            return start
        if entry["target"] == "event":
            start = entry["created"].timestamp()
    # Without a preceding after-hours transition, an event click could simply
    # reopen requests during the same event. Keep the persisted session intact.
    return 0


def _run():
    from django.conf import settings
    from django.db import close_old_connections, connections
    from django.utils import timezone
    from core import models, redis, site_mode
    from core.safe_files import atomic_write_text
    from core.settings import storage

    directory = Path(settings.BASE_DIR) / "config"
    state_path, message_path = directory / STATE_NAME, directory / MESSAGE_NAME
    try:
        raw = state_path.read_text(encoding="utf-8") if state_path.stat().st_size <= 1024 * 1024 else "{}"
        director = Director(json.loads(raw))
        # Validate the persisted schema before allowing it to schedule anything.
        if director.state:
            for key in ("start", "mode", "plays", "current", "watermarks", "sent", "lastReminder", "active", "pending"):
                director.state[key]
    except (OSError, ValueError, KeyError, TypeError):
        director = Director()
    saved = None
    last_error = 0
    fields = ("occurrence_id", "external_url", "artist", "title", "votes")
    try:
        while not _stop.is_set():
            try:
                close_old_connections()
                now = timezone.now()
                mode = site_mode.get_mode()
                marker = _event_marker(now)
                cutoff = now - datetime.timedelta(hours=24)
                history = models.PlaybackHistory.objects.filter(ended_at__gte=cutoff).order_by("-ended_at").values(*fields, "started_at")[:MAX_PLAYS]
                rows = [_row(song, song["started_at"]) for song in history]
                song = models.CurrentSong.objects.values(*fields, "playback_started_at").first()
                current = _row(song, song["playback_started_at"]) if song and song["playback_started_at"] else None
                if current:
                    rows.append(current)
                # Baseline requester votes have activity_recorded=False. Count
                # actual listeners' remaining positive choices, not click/undo
                # traffic or a queue's automatic one-vote starting scores.
                recent_votes = models.SongVote.objects.filter(
                    activity_recorded=True, choice=1,
                    changed_at__gte=now - datetime.timedelta(hours=1),
                ).count()
                enabled = (not storage.get("paused") and not redis.get("alarm_playing")
                           and not redis.get("backup_playing")
                           and storage.get("interactivity") in (
                               storage.Interactivity.full_voting, storage.Interactivity.upvotes_only))
                message = director.update(now.timestamp(), mode, marker, rows, current, recent_votes,
                                          enabled=enabled, skip_at=-int(storage.get("downvotes_to_kick")))
                serialized = json.dumps(director.state, separators=(",", ":"), allow_nan=False)
                if serialized != saved:
                    # Commit cooldowns BEFORE publishing. Failure cannot produce
                    # an announcement whose state would be lost at the restart.
                    atomic_write_text(state_path, serialized, attempts=1)
                    saved = serialized
                atomic_write_text(message_path, json.dumps({
                    "version": 1, "updatedAt": now.timestamp(), "message": message,
                }, separators=(",", ":"), allow_nan=False), attempts=1)
            except Exception:  # optional overlays must never interrupt music
                if time.monotonic() - last_error >= 60:
                    LOGGER.exception("OBS vote notifications temporarily unavailable")
                    last_error = time.monotonic()
                connections.close_all()
                director.rebase = True
            _stop.wait(2)
    finally:
        connections.close_all()


def start():
    global _thread
    with _lock:
        if _thread is None or not _thread.is_alive():
            _stop.clear()
            _thread = threading.Thread(target=_run, name="obs-vote-notifications", daemon=True)
            _thread.start()


def stop():
    _stop.set()
    if _thread and _thread is not threading.current_thread():
        _thread.join(timeout=2)
