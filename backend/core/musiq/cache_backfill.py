"""One resumable, low-priority metadata repair at a time for old audio caches."""
import logging
import threading
import time
from django.db import close_old_connections, connections

_stop = threading.Event()
_thread = None
_lock = threading.Lock()
LOG = logging.getLogger(__name__)


def _run():
    from core import models
    from core.musiq import song_cache
    from core.musiq.youtube import YoutubeSongProvider
    try:
        while not _stop.wait(30):
            try:
                close_old_connections()
                # A new download/lookup always takes precedence over old data.
                if models.RequestReservation.objects.exists() or models.QueuedSong.objects.filter(internal_url__isnull=True).exists():
                    continue
                row = models.RuntimeState.objects.filter(key='song-cache-backfill').first()
                state = row.value if row else {}
                if time.time() < state.get('retryAt', 0):
                    continue
                song = models.ArchivedSong.objects.filter(cached=True, id__gt=state.get('cursor', 0)).order_by('id').first()
                if not song:
                    models.RuntimeState.objects.update_or_create(key='song-cache-backfill', defaults={'value':{'cursor':0,'retryAt':time.time()+86400}})
                    continue
                data = dict(song.cached_metadata or {})
                if song_cache.audio_exists(song) and (not str(data.get('artwork_url','')).startswith('/song-artwork/') or data.get('lyrics_status') not in {'found','missing'}):
                    try:
                        provider = YoutubeSongProvider(song.url, song.pk)
                        provider.force_metadata_refresh = True
                        provider.gather_metadata()
                        source = provider.metadata.get('artwork_url') or data.get('artwork_source') or data.get('artwork_url')
                        art = song_cache.save_artwork(song, source)
                        lyrics, status = fetch_lyrics(song.artist, song.title, song.duration) if data.get('lyrics_status') not in {'found','missing'} else (None, None)
                        song_cache.merge(song, artwork_url=art or None, artwork_source=source if source and not source.startswith('/') else None,
                                         genre=provider.metadata.get('genre') or None, lyrics=lyrics, lyrics_status=status)
                    except Exception:
                        LOG.warning('Cached metadata backfill will retry on a later pass', exc_info=True)
                models.RuntimeState.objects.update_or_create(key='song-cache-backfill', defaults={'value':{'cursor':song.pk}})
            except Exception:
                LOG.warning('Cached metadata backfill temporarily unavailable', exc_info=True)
            finally:
                connections.close_all()
    finally:
        connections.close_all()


def fetch_lyrics(artist, title, duration):
    """Keep the same LRCLIB lookup behavior as foreground guideline analysis."""
    import requests
    headers = {'User-Agent':'FURATIC/1.0 (non-commercial event)'}
    response = requests.get('https://lrclib.net/api/get', params={'artist_name':artist,'track_name':title,'duration':round(duration)}, headers=headers, timeout=8)
    if response.status_code == 404:
        response = requests.get('https://lrclib.net/api/search', params={'artist_name':artist,'track_name':title}, headers=headers, timeout=8)
        response.raise_for_status()
        candidates = response.json()
        data = min(candidates if isinstance(candidates,list) else [], key=lambda item:abs(float(item.get('duration') or 0)-duration), default={})
    else:
        response.raise_for_status()
        data = response.json()
    lyrics = str(data.get('plainLyrics') or '')[:100000]
    return lyrics, 'found' if lyrics else 'missing'


def start():
    global _thread
    with _lock:
        if _thread is None or not _thread.is_alive():
            _stop.clear()
            _thread = threading.Thread(target=_run, name='song-cache-backfill', daemon=True)
            _thread.start()


def stop():
    _stop.set()
