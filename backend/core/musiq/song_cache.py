"""Durable per-video data shared by search, playback, moderation and OBS."""
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlparse

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, Http404
from core.input_validation import VIDEO_ID, youtube_video_id


def normalized(value):
    return ' '.join(re.findall(r'\w+', unicodedata.normalize('NFKC', str(value)).casefold()))


def audio_exists(row):
    try:
        video = youtube_video_id(row.url)
        path = Path(settings.SONGS_CACHE_DIR) / (video + '.m4a')
        return path.is_file() and path.stat().st_size > 0
    except (ValueError, OSError):
        return False


def local_matches(query, limit=40):
    from core.models import ArchivedSong
    words = normalized(query).split()[:16]
    if not words:
        return []
    # Match old request aliases as well as artist/title, without scanning audio.
    alias = Q(queries__query__iexact=str(query).strip())
    from core.settings import storage
    keywords = str(storage.get('additional_keywords') or '').strip()
    if keywords:
        alias |= Q(queries__query__iexact=str(query).strip() + ' ' + keywords)
    credits = Q()
    for word in words:
        credits &= Q(artist__icontains=word) | Q(title__icontains=word)
    rows = ArchivedSong.objects.filter(cached=True).filter(alias | credits).distinct().order_by('-counter', 'id')[:120]
    result = [row for row in rows if audio_exists(row)]
    key = normalized(query)
    result.sort(key=lambda row: (key not in {normalized(row.artist + ' ' + row.title), normalized(row.title + ' ' + row.artist), normalized(row.title)}, -row.counter))
    return result[:limit]


def resolve(query):
    matches = local_matches(query)
    key = normalized(query)
    for row in matches:
        exact = {normalized(row.artist + ' ' + row.title), normalized(row.title + ' ' + row.artist), normalized(row.title)}
        if key in exact or row.queries.filter(query__iexact=str(query).strip()).exists():
            return row
    # Unambiguous cached artist/title token matches remain usable offline.
    return matches[0] if len(matches) == 1 else None


def artwork_path(video):
    if not VIDEO_ID.fullmatch(video):
        raise ValueError('Invalid video ID')
    return Path(settings.SONGS_CACHE_DIR) / 'artwork' / (video + '.img')


def artwork_url(video):
    return '/song-artwork/' + video + '/'


def artwork(request, video):
    try:
        path = artwork_path(video)
        if not path.is_file():
            raise Http404
        with path.open('rb') as source:
            header = source.read(12)
        mime = 'image/png' if header.startswith(b'\x89PNG') else 'image/webp' if header.startswith(b'RIFF') else 'image/jpeg'
        response = FileResponse(path.open('rb'), content_type=mime)
        response['Cache-Control'] = 'public, max-age=86400'
        response['X-Content-Type-Options'] = 'nosniff'
        return response
    except (ValueError, OSError):
        raise Http404 from None


def save_artwork(row, source):
    """Fetch only provider image hosts; bound bytes before buffering to disk."""
    import requests
    import os
    import tempfile
    video = youtube_video_id(row.url)
    path = artwork_path(video)
    if path.is_file() and path.stat().st_size:
        return artwork_url(video)
    parsed = urlparse(source or '')
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or not (host == 'yt3.ggpht.com' or host.endswith('.ytimg.com') or host.endswith('.googleusercontent.com') or host.endswith('.ggpht.com')):
        return ''
    try:
        # Redirects cannot turn an image fetch into arbitrary network access.
        with requests.get(source, timeout=8, stream=True, allow_redirects=False) as response:
            if not response.ok or not response.headers.get('content-type', '').startswith('image/'):
                return ''
            data = bytearray()
            for chunk in response.iter_content(32768):
                data.extend(chunk)
                if len(data) > 2 * 1024 * 1024:
                    return ''
            if not (data[:3] == b'\xff\xd8\xff' or data[:8] == b'\x89PNG\r\n\x1a\n' or data[:4] == b'RIFF'):
                return ''
            path.parent.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
            try:
                with os.fdopen(handle, 'wb') as target:
                    target.write(data)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return artwork_url(video)
    except (requests.RequestException, OSError):
        return ''


def merge(row, **fields):
    """Serialize small per-video updates; never hold a lock during HTTP work."""
    from core.models import ArchivedSong
    from django.db import transaction
    with transaction.atomic():
        current = ArchivedSong.objects.select_for_update().get(pk=row.pk)
        data = dict(current.cached_metadata or {})
        for key, value in fields.items():
            if value is not None and (value != '' or key in {'lyrics', 'lyrics_status'}):
                data[key] = value
        current.cached_metadata = data
        current.save(update_fields=['cached_metadata'])
    row.cached_metadata = data
    local_art = fields.get('artwork_url')
    if isinstance(local_art, str) and local_art.startswith('/song-artwork/'):
        from core.models import PlaybackHistory, CurrentSong, QueuedSong
        # Old history should remain illustrated offline too; no audio/queue
        # ownership, votes or playback timing are changed by this update.
        for model in (PlaybackHistory, CurrentSong, QueuedSong):
            model.objects.filter(external_url=row.url).exclude(artwork_url=local_art).update(artwork_url=local_art)
