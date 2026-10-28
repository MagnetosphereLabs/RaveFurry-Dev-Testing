"""Rich YouTube picker with bounded, shared lookups and opaque page cursors."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import logging
import math
import threading
import time
import uuid

from django.core import signing
from django.http import JsonResponse
from django.views.decorators.http import require_GET
from core import site_mode
from core.input_validation import VIDEO_ID, music_query
from core.musiq import song_cache, song_utils
from core.settings import storage

LOG = logging.getLogger(__name__)
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix='song-search')
_slots = threading.BoundedSemaphore(6)  # No unbounded executor waiting queue.
_lock = threading.RLock()
_cache = OrderedDict()
PAGE = 5
TTL = 300
MAX_RESULTS = 100


def _row(video, title, artist, duration, artwork, cached=False):
    if not VIDEO_ID.fullmatch(str(video or '')) or not title:
        return None
    try:
        duration = max(0, float(duration or 0))
    except (ValueError, TypeError):
        duration = 0
    if not math.isfinite(duration):
        duration = 0
    if song_utils.is_forbidden(str(title)) or song_utils.is_forbidden(str(artist)):
        return None
    maximum = float(storage.get('max_song_duration_seconds'))
    if maximum > 0 and duration > maximum:
        return None
    return {'videoId': video, 'title': str(title)[:1000], 'artist': str(artist)[:1000],
            'duration': duration, 'durationFormatted': song_utils.format_seconds(duration) if duration else '',
            'artworkUrl': str(artwork or '')[:2000], 'url': 'https://www.youtube.com/watch?v=' + video,
            'cached': cached}


def _local(query):
    from core.input_validation import youtube_video_id
    rows = []
    for song in song_cache.local_matches(query, limit=MAX_RESULTS):
        item = _row(youtube_video_id(song.url), song.title, song.artist, song.duration,
                    (song.cached_metadata or {}).get('artwork_url', ''), True)
        if item:
            rows.append(item)
    return rows


def _lookup(entry, limit):
    from django.db import close_old_connections, connections
    try:
        close_old_connections()
        from core.musiq.youtube import get_ytmusic
        client = get_ytmusic(timeout=8)
        # Public API paginates internally for a filtered search. Keep those
        # batches server-side; do not expose or depend on private API tokens.
        found = []
        query = entry['query']
        keywords = str(storage.get('additional_keywords') or '')
        if keywords:
            query += ' ' + keywords
        added = 0
        for kind in ('songs', 'videos'):
            batch = []
            for row in client.search(query, filter=kind, limit=limit):
                thumbs = row.get('thumbnails') or []
                artists = row.get('artists') or []
                item = _row(row.get('videoId'), row.get('title'),
                            ', '.join(str(a.get('name') or '') for a in artists),
                            row.get('duration_seconds') or _seconds(row.get('duration')),
                            thumbs[-1].get('url', '') if thumbs else '')
                if item:
                    batch.append(item)
            found.extend(batch)
            # Publish the first useful batch immediately; videos needn't delay
            # showing song results. Later HTTP readers reuse these same rows.
            with _lock:
                ids = {row['videoId'] for row in entry['rows']}
                for row in batch:
                    if row['videoId'] not in ids and len(entry['rows']) < MAX_RESULTS:
                        entry['rows'].append(row)
                        ids.add(row['videoId'])
                        added += 1
        with _lock:
            entry['limit'] = limit
            entry['exhausted'] = limit >= MAX_RESULTS or (limit > 20 and not added) or len(found) < limit
            entry['error'] = False
    except Exception:
        LOG.warning('YouTube picker lookup temporarily unavailable', exc_info=True)
        with _lock:
            entry['error'] = True
            entry['retryAt'] = time.monotonic() + 15
    finally:
        with _lock:
            entry['running'] = False
        _slots.release()
        connections.close_all()


def _seconds(value):
    try:
        result = 0
        for number in str(value or '').split(':'):
            result = result * 60 + int(number)
        return result
    except ValueError:
        return 0


@require_GET
def search(request):
    if not site_mode.accepts_song_requests() or not storage.get('youtube_enabled'):
        return JsonResponse({'results': [], 'next': None, 'message': 'Song requests are closed.'})
    try:
        query = music_query(request.GET.get('q'))
        if 'http://' in query.lower() or 'https://' in query.lower() or len(query) > 200:
            raise ValueError('Type a song or artist to search.')
        offset, key = 0, None
        if request.GET.get('cursor'):
            cursor = signing.loads(request.GET['cursor'], salt='song-search', max_age=TTL)
            offset, key = int(cursor['offset']), cursor['key']
            if offset < 0 or offset > MAX_RESULTS:
                raise ValueError('Invalid page.')
    except (ValueError, TypeError, KeyError, signing.BadSignature):
        return JsonResponse({'message': 'Please search again.', 'results': [], 'next': None}, status=400)
    now = time.monotonic()
    with _lock:
        for old in list(_cache):
            if now - _cache[old]['created'] > TTL:
                del _cache[old]
        entry = _cache.get(key) if key else next((x for x in _cache.values() if x['query'] == query), None)
        if key and (entry is None or entry['query'] != query):
            return JsonResponse({'message': 'Search expired. Please search again.', 'results': [], 'next': None}, status=410)
    if entry is None:
        local = _local(query)
        with _lock:
            # Recheck after the database read so identical first requests share work.
            entry = next((x for x in _cache.values() if x['query'] == query), None)
            if entry is None:
                entry = {'key': uuid.uuid4().hex, 'query': query, 'created': now, 'rows': local,
                         'limit': 0, 'running': False, 'exhausted': False, 'error': False, 'retryAt': 0}
                _cache[entry['key']] = entry
                while len(_cache) > 128:
                    _cache.popitem(last=False)
    with _lock:
        needs = len(entry['rows']) < offset + PAGE
        if needs and not entry['running'] and not entry['exhausted'] and now >= entry['retryAt'] and _slots.acquire(blocking=False):
            entry['running'] = True
            _pool.submit(_lookup, entry, min(MAX_RESULTS, entry['limit'] + 20))
        rows = list(entry['rows'][offset:offset + PAGE])
        pending = len(rows) < PAGE and (entry['running'] or not entry['exhausted'] and not entry['error'])
        next_offset = offset + len(rows)
        more = next_offset < len(entry['rows']) or not entry['exhausted'] and not entry['error']
        cursor = signing.dumps({'key': entry['key'], 'offset': next_offset}, salt='song-search') if more else None
        value = {'results': rows, 'next': cursor, 'pending': pending,
                 'message': 'Search is temporarily unavailable. You can still submit a link or search text.' if entry['error'] else ''}
    response = JsonResponse(value)
    response['Cache-Control'] = 'private, no-store'
    return response
