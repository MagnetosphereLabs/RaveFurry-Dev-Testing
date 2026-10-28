"""Five event charts beside the OBS exports; never shipped as installer data.

Only initialization and mode transitions write the archive. Normal page polls
and late votes read the database, leaving both playback and the archive alone.
"""
from __future__ import annotations

from contextlib import contextmanager
import datetime
import json
import logging
import os
from pathlib import Path
import threading
import time
import uuid

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from core import models, queue_lock
from core.musiq.display_name import clean_display_names
from core.safe_files import atomic_write_text

LOGGER = logging.getLogger(__name__)
FILE_NAME = "topcharts.json"
MAX_EVENTS = 5
MAX_BYTES = 8 * 1024 * 1024
_lock = threading.RLock()


def _path():
    return Path(settings.FURATIC_OBS_OUTPUT_DIR).expanduser() / FILE_NAME


def _date(value):
    result = parse_datetime(str(value or ""))
    if result is None or timezone.is_naive(result):
        raise ValueError("Invalid event timestamp")
    return result


def _read():
    path = _path()
    try:
        with path.open("r", encoding="utf-8") as stream:
            raw = stream.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    if len(raw.encode("utf-8")) > MAX_BYTES:
        raise ValueError("Event chart archive exceeds its size limit")
    data = json.loads(raw)
    if (not isinstance(data, dict) or data.get("version") != 1
            or not isinstance(data.get("events"), list) or len(data["events"]) > MAX_EVENTS
            or not isinstance(data.get("active"), dict)):
        raise ValueError("Invalid event chart archive; existing file preserved")
    _date(data["active"]["startedAt"])
    for event in data["events"]:
        _date(event["startedAt"])
        if not isinstance(event.get("songs"), list) or not isinstance(event.get("history"), list):
            raise ValueError("Invalid saved event; existing file preserved")
    return data


@contextmanager
def _writer():
    """Serialize Windows/Unix processes as well as request/playback threads."""
    with _lock:
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.with_suffix(".lock").open("a+b") as guard:
            guard.seek(0, 2)
            if guard.tell() == 0:
                guard.write(b"0")
                guard.flush()
            deadline = time.monotonic() + 2
            while True:
                try:
                    guard.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(guard.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(guard.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except (BlockingIOError, PermissionError, OSError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Event chart archive is busy")
                    time.sleep(.02)
            try:
                yield
            finally:
                guard.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(guard.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(guard.fileno(), fcntl.LOCK_UN)


def _infer_start(now):
    # Recover one real event on first installation, not fictitious older dates.
    entries = models.AuditEntry.objects.filter(
        action__in=("moderator_set_site_mode", "closing_queue_finished"),
        created__gte=now - datetime.timedelta(hours=24),
    ).order_by("-created").values("target", "created")[:128]
    start = None
    passed_end = False
    for entry in entries:
        if entry["target"] == "afterhours":
            if start is not None or passed_end:
                break
            passed_end = True
        elif entry["target"] == "event":
            start = entry["created"]
    if start is not None:
        return start
    times = list(models.PlaybackHistory.objects.filter(
        ended_at__gte=now - datetime.timedelta(hours=12), ended_at__lte=now,
    ).values_list("started_at", flat=True))
    times.extend(models.CurrentSong.objects.filter(
        playback_started_at__gte=now - datetime.timedelta(hours=12),
        playback_started_at__lte=now,
    ).values_list("playback_started_at", flat=True))
    return min(times, default=now)


def current_start():
    """Read only: safe even inside the playback handoff transaction."""
    try:
        data = _read()
        return _date(data["active"]["startedAt"]) if data else _infer_start(timezone.now())
    except (OSError, ValueError, KeyError, TypeError):
        LOGGER.exception("could not read event boundary")
        return None


def _active(start, mode):
    return {"id": uuid.uuid4().hex, "startedAt": start.isoformat(), "mode": mode, "endedAt": None}


def _capture(active, now):
    from core.musiq.song_cache import display_artwork
    start = _date(active["startedAt"])
    end = _date(active["endedAt"]) if active.get("endedAt") else now
    fields = ("occurrence_id", "external_url", "artist", "title", "artwork_url", "votes", "duration")
    with transaction.atomic():
        queue_lock.acquire()
        rows = list(models.PlaybackHistory.objects.filter(
            started_at__gte=start, started_at__lte=end,
        ).order_by("-ended_at", "-id").values(*fields, "ended_at", "outcome")[:4096])
        seen = {row["occurrence_id"] for row in rows}
        current = list(models.CurrentSong.objects.filter(
            playback_started_at__gte=start, playback_started_at__lte=end,
        ).exclude(occurrence_id__in=seen).values(*fields))
    history = []
    songs = {}
    for index, row in enumerate(current + rows):
        artist, title = clean_display_names(row["artist"], row["title"])
        title, artist = title or "Untitled song", artist or "Unknown artist"
        row['artwork_url'] = display_artwork(row['external_url'], row['artwork_url'])
        key = row["external_url"] or (artist, title)
        if key not in songs:
            songs[key] = {"title": title, "artist": artist, "artworkUrl": row["artwork_url"], "externalUrl": row["external_url"], "votes": 0, "duration": float(row["duration"] or 0)}
        songs[key]["votes"] += int(row["votes"] or 0)
        if index >= len(current) and len(history) < 50:
            history.append({"id": str(row["occurrence_id"]), "title": title, "artist": artist, "externalUrl": row["external_url"],
                            "artworkUrl": row["artwork_url"], "votes": int(row["votes"] or 0),
                            "duration": row["duration"], "endedAt": row["ended_at"].isoformat(),
                            "outcome": row["outcome"]})
    chart = sorted(songs.values(), key=lambda song: (
        -song["votes"], song["title"].casefold(), song["artist"].casefold(),
    ))[:50]
    return {"id": active["id"], "startedAt": active["startedAt"], "endedAt": active.get("endedAt"),
            "songs": [{key: value for key, value in song.items() if key != 'duration'} for song in chart[:20]],
            "showcaseSongs": chart, "history": history}


def obs_data():
    """A frozen, bounded OBS chart; the website keeps its existing top twenty."""
    from core.input_validation import youtube_video_id
    data = _read()
    if not data or data['active'].get('mode') != 'afterhours' or not data['active'].get('endedAt'):
        return None
    active = data['active']
    event = next((row for row in data['events'] if row['id'] == active['id']), None)
    if event is None or 'showcaseSongs' not in event:
        event = _capture(active, _date(active['endedAt']))
    result = []
    for song in event.get('showcaseSongs', [])[:50]:
        try:
            video = youtube_video_id(song.get('externalUrl', ''))
        except (ValueError, TypeError):
            video = ''
        result.append({'title': song['title'], 'artist': song['artist'], 'votes': int(song['votes']),
                       'duration': max(0.0, float(song.get('duration') or 0)), 'videoId': video})
    return {'version': 1, 'eventId': active['id'], 'endedAt': _date(active['endedAt']).timestamp(), 'songs': result}


def _put(events, event):
    if not event["songs"]:
        return events
    return sorted([item for item in events if item["id"] != event["id"]] + [event],
                  key=lambda item: _date(item["startedAt"]), reverse=True)[:MAX_EVENTS]


def _initialize(mode, now):
    data = {"version": 1, "active": _active(_infer_start(now), mode), "events": []}
    if mode in ("closing", "afterhours"):
        if mode == "afterhours":
            data["active"]["endedAt"] = now.isoformat()
        data["events"] = _put([], _capture(data["active"], now))
    return data


def sync_mode(mode):
    """Optional post-commit hook. No recurring writes or playback side effects."""
    try:
        with _writer():
            now = timezone.now()
            data = _read()
            before = json.dumps(data, sort_keys=True)
            if data is None:
                data = _initialize(mode, now)
            active = data["active"]
            previous = active["mode"]
            if mode == "event" and previous == "afterhours":
                data["active"] = active = _active(now, mode)
            elif mode in ("closing", "afterhours") and previous != mode:
                active["endedAt"] = now.isoformat() if mode == "afterhours" else None
                data["events"] = _put(data["events"], _capture(active, now))
            active["mode"] = mode
            if json.dumps(data, sort_keys=True) != before:
                atomic_write_text(_path(), json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
                                  attempts=3, logger=LOGGER)
    except Exception:  # An optional chart export must never interrupt an event.
        LOGGER.exception("could not save event charts; existing archive preserved")


def _repair_chart_artwork(rows):
    """Repair pre-update saved charts in the response, without rewriting them."""
    from django.db.models import Q
    from core.musiq.song_cache import display_artwork
    missing = [row for row in rows if not row.get('artworkUrl')]
    if not missing:
        return
    titles = {row['title'] for row in missing}
    artists = {row['artist'] for row in missing}
    candidates = models.ArchivedSong.objects.filter(Q(title__in=titles) | Q(artist__in=artists)).only('url', 'artist', 'title', 'cached_metadata')[:1000]
    matches = {clean_display_names(row.artist, row.title): row for row in candidates}
    for row in missing:
        archived = matches.get((row['artist'], row['title']))
        url = row.get('externalUrl') or (archived.url if archived else '')
        row['artworkUrl'] = display_artwork(url, (archived.cached_metadata or {}).get('artwork_url', '') if archived else '')


def public_data(event_id=None):
    """One selected chart/history and only the event dates actually available."""
    data = _read()
    if data is None:
        from core import site_mode
        sync_mode(site_mode.get_mode())
        data = _read()
    if data is None:
        # A read-only export directory must not hide the live database chart.
        from core import site_mode
        data = _initialize(site_mode.get_mode(), timezone.now())
    events = list(data["events"])
    if data["active"]["mode"] != "afterhours":
        events = _put(events, _capture(data["active"], timezone.now()))
    selected = next((event for event in events if event["id"] == event_id), None)
    if selected is None:
        selected = events[0] if events else None
    if selected:
        _repair_chart_artwork(selected['songs'] + selected['history'])
    return {"events": [{key: event[key] for key in ("id", "startedAt", "endedAt")} for event in events],
            "eventId": selected["id"] if selected else None,
            "songs": selected["songs"] if selected else [],
            "history": selected["history"] if selected else []}
