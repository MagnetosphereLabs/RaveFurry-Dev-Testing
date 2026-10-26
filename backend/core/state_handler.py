"""This module handles state responses.

Frontend state updates use HTTP polling. The websocket route is kept as a
no-op compatibility endpoint so cached/old clients that still connect to
/state/ do not create Channels routing errors or reconnect storms.
"""

import logging
import threading
import time
from typing import Any, Dict, Optional

from channels.generic.websocket import AsyncWebsocketConsumer
from django.core.handlers.wsgi import WSGIRequest
from django.http import JsonResponse

logger = logging.getLogger(__name__)
_snapshot_lock = threading.RLock()
_snapshot_build_lock = threading.Lock()
_snapshot = None
_snapshot_at = 0.0
_snapshot_generation = 0
_SNAPSHOT_TTL = 0.2


def snapshot_generation():
    """Version shared by read-only polling snapshots; mutations advance it."""
    with _snapshot_lock:
        return _snapshot_generation


def send_state(_state: Dict[str, Any]) -> None:
    """State changes are picked up by frontend HTTP polling.

    This must stay cheap and non-blocking because it is called from song add,
    download completion, voting, playback changes, and settings changes.
    """
    global _snapshot, _snapshot_at, _snapshot_generation
    with _snapshot_lock:
        _snapshot_generation += 1
        # These are public queue/transport fields. Personal votes, ownership,
        # permissions and moderator responses never enter this shared cache.
        _snapshot = _state if "musiq" in _state else None
        _snapshot_at = time.monotonic() if _snapshot is not None else 0.0


def get_state(_request: WSGIRequest, module) -> JsonResponse:
    """Calls the get_state function of the given module and returns its result."""
    global _snapshot, _snapshot_at
    if module.__name__ != "core.musiq.musiq":
        return JsonResponse(module.state_dict())
    with _snapshot_lock:
        if _snapshot is not None and time.monotonic() - _snapshot_at < _SNAPSHOT_TTL:
            return JsonResponse(_snapshot)
    # Simultaneous polls share one DB snapshot instead of rebuilding the same
    # twenty-song queue eighty times. Mutations publish/invalidate immediately.
    acquired = _snapshot_build_lock.acquire(blocking=False)
    if not acquired:
        with _snapshot_lock:
            # Keep a short-lived, complete view while another request refreshes
            # it. Do not occupy every HTTP worker waiting for the same DB read.
            if _snapshot is not None and time.monotonic() - _snapshot_at < 2:
                return JsonResponse(_snapshot)
        if not _snapshot_build_lock.acquire(timeout=1):
            response = JsonResponse({"message": "Queue update is still in progress. Please retry shortly."}, status=503)
            response["Retry-After"] = "1"
            return response
    try:
        with _snapshot_lock:
            if _snapshot is not None and time.monotonic() - _snapshot_at < _SNAPSHOT_TTL:
                return JsonResponse(_snapshot)
            generation = _snapshot_generation
        state = module.state_dict()
        with _snapshot_lock:
            if generation == _snapshot_generation:
                _snapshot, _snapshot_at = state, time.monotonic()
            elif _snapshot is not None:
                state = _snapshot
    finally:
        _snapshot_build_lock.release()
    return JsonResponse(state)


class StateConsumer(AsyncWebsocketConsumer):
    """Compatibility websocket for cached clients.

    Do not join groups. Do not send state. Do not close immediately. Keeping the
    socket open prevents old ReconnectingWebSocket clients from hammering the
    server with reconnect attempts.
    """

    async def connect(self) -> None:
        await self.accept()

    async def disconnect(self, code: int) -> None:
        return

    async def receive(
        self,
        text_data: Optional[str] = None,
        bytes_data: Optional[bytes] = None,
    ) -> None:
        return

