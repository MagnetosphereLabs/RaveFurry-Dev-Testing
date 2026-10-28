"""Small coalesced OBS snapshots over authenticated loopback HTTP, never files."""
import json
import os
import threading
import time
import urllib.request
from types import SimpleNamespace

from core.input_validation import youtube_video_id
from core.musiq.display_name import clean_display_names

_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_artwork = None
_artwork_lock = threading.Lock()
_results = None
_results_checked = 0.0


def start():
    from core import obs_notifications
    obs_notifications.start()


def stop():
    from core import obs_notifications
    obs_notifications.stop()


def _post(path, body, content_type='application/json'):
    token = os.environ.get('FURATIC_OBS_PUBLISH_TOKEN', '')
    if not token:
        return None
    port = int(os.environ.get('FURATIC_VISUALIZER_PORT', '8766'))
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + path, data=body,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    with _http.open(request, timeout=.8) as response:
        return json.loads(response.read(1024))


def publish(song, mode, message, *, queue_empty, paused, alarm=False, backup=False):
    from django.utils import timezone
    from core.musiq import audio_tail, song_cache
    now = timezone.now()
    current = None
    video = ''
    if song:
        artist, title = clean_display_names(song['artist'], song['title'])
        duration = audio_tail.effective_duration_for_song(SimpleNamespace(**song))
        duration = max(0.0, float(duration or song['duration'] or 0))
        at = song['last_paused'] if paused else now
        position = max(0.0, min(duration, (at - song['created']).total_seconds()))
        try:
            video = youtube_video_id(song['external_url'])
        except ValueError:
            pass
        current = {'id': str(song['occurrence_id']), 'title': title, 'artist': artist,
                   'votes': song['votes'], 'duration': duration, 'position': position,
                   'paused': bool(paused), 'artwork': '/overlay-artwork/' + video if video else ''}
    if alarm or backup:
        current = {'id': 'alarm' if alarm else 'backup', 'title': 'ALARM!' if alarm else 'Backup Stream',
                   'artist': '', 'votes': 0, 'duration': 0, 'position': 0, 'paused': True, 'artwork': ''}
        video = ''
    global _results, _results_checked
    if mode != 'afterhours':
        _results = None
        _results_checked = 0.0
    elif time.monotonic() - _results_checked >= 5 or _results is None:
        from core import event_charts
        _results_checked = time.monotonic()
        _results = event_charts.obs_data()
    event = ({key: _results[key] for key in ('eventId', 'endedAt')} if _results else None)
    payload = {'version': 1, 'updatedAt': now.timestamp(), 'mode': mode, 'song': current, 'event': event,
               'queueEmpty': bool(queue_empty), 'message': message}
    result = _post('/overlay-state', json.dumps(payload, separators=(',', ':'), allow_nan=False).encode())
    if result and _results and result.get('resultsId') != _results['eventId']:
        _post('/overlay-results', json.dumps(_results, separators=(',', ':'), allow_nan=False).encode())
    if not result or not video or result.get('artworkId') == video:
        return
    try:
        # One decoded cover is held by the companion; re-send only after a song
        # change/restart. No per-frame disk reads and no per-queue file copies.
        path = song_cache.ensure_artwork(video)
        if path is None:
            return
        with _artwork_lock:
            global _artwork
            stat = path.stat()
            signature = (video, stat.st_mtime_ns, stat.st_size)
            if stat.st_size > 2 * 1024 * 1024:
                return
            if not _artwork or _artwork[0] != signature:
                _artwork = (signature, path.read_bytes())
            data = _artwork[1]
        _post('/overlay-artwork/' + video, data, 'application/octet-stream')
    except (OSError, ValueError):
        pass  # Missing artwork cannot stop the song or metadata display.
