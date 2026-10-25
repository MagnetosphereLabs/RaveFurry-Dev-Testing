from redis.exceptions import RedisError
from django.db import transaction

from core import redis
from core.settings import storage

EVENT_MODE = "event"
CLOSING_MODE = "closing"
AFTER_HOURS_MODE = "afterhours"

VALID_MODES = {EVENT_MODE, CLOSING_MODE, AFTER_HOURS_MODE}


def _normalize_mode(mode: str) -> str:
    return mode if mode in VALID_MODES else EVENT_MODE


def get_mode() -> str:
    try:
        raw_mode = redis.connection.get("site_mode")
    except RedisError:
        raw_mode = ""

    if raw_mode in VALID_MODES:
        return raw_mode

    return _normalize_mode(str(storage.get("site_mode")))


def set_mode(mode: str) -> str:
    normalized = _normalize_mode(mode)
    storage.put("site_mode", normalized)
    redis.put("site_mode", normalized)
    # Capture after the surrounding queue transaction commits. The optional
    # archive handles its own failures and never changes playback or mode flow.
    from core import event_charts
    transaction.on_commit(lambda: event_charts.sync_mode(get_mode()))
    return normalized


def is_afterhours() -> bool:
    return get_mode() == AFTER_HOURS_MODE


def is_closing() -> bool:
    return get_mode() == CLOSING_MODE


def accepts_song_requests() -> bool:
    return get_mode() == EVENT_MODE
