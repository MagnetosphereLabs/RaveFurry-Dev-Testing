"""Best-effort free lyrics lookup and configurable guideline analysis."""
import os
import re
import logging
import requests
from pathlib import Path
from django.conf import settings
from core import models
from core.tasks import app

DEFAULT_PROFANITY = "fuck,shit,bitch,asshole,cunt,motherfucker"
# Kept backend-only so public clients never receive the detection dictionary.
DEFAULT_SLURS = "nigger,nigga,faggot,fag,tranny,kike,spic,chink,wetback,retard"
LOGGER = logging.getLogger(__name__)


def _terms(name):
    default = DEFAULT_SLURS if name == "FURATIC_SLUR_TERMS" else DEFAULT_PROFANITY
    return [term.strip() for term in os.environ.get(name, default).split(",") if term.strip()]


def _count(text, terms):
    return sum(len(re.findall(r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, re.I)) for term in terms)


def matched_terms(text):
    """Return only configured terms actually present, for moderator highlighting."""
    return {
        "profanity": [term for term in _terms("FURATIC_PROFANITY_TERMS") if _count(text, [term])],
        "slurs": [term for term in _terms("FURATIC_SLUR_TERMS") if _count(text, [term])],
    }


@app.task
def analyze_song(queue_key: int) -> None:
    """Fetch LRCLIB lyrics without ever delaying or failing song enqueue."""
    song = models.QueuedSong.objects.filter(id=queue_key).first()
    if not song:
        return
    from core.musiq import song_cache
    archived = models.ArchivedSong.objects.filter(url=song.external_url).first()
    cached = dict(archived.cached_metadata or {}) if archived else {}
    if archived:
        try:
            local_art = song_cache.save_artwork(archived, song.artwork_url or cached.get('artwork_url', ''))
            if local_art:
                song_cache.merge(archived, artwork_url=local_art, artwork_source=song.artwork_url if not song.artwork_url.startswith('/') else None)
                models.QueuedSong.objects.filter(id=queue_key).update(artwork_url=local_art)
        except (ValueError, OSError):
            pass
    manually_held = (
        song.review_status == "pending"
        and song.review_reason == "Held manually by moderator"
    )
    updates = {
        "review_status": "pending" if manually_held else "clear",
        "review_reason": song.review_reason if manually_held else "",
    }
    try:
        if cached.get('lyrics_status') in {'found', 'missing'}:
            lyrics = str(cached.get('lyrics') or '')
        else:
            from core.musiq.cache_backfill import fetch_lyrics
            lyrics, lyrics_status = fetch_lyrics(song.artist, song.title, song.duration)
            if archived:
                song_cache.merge(archived, lyrics=lyrics, lyrics_status=lyrics_status)
        profanity_count = _count(lyrics, _terms("FURATIC_PROFANITY_TERMS"))
        slur_count = _count(lyrics, _terms("FURATIC_SLUR_TERMS"))
        updates.update(
            lyrics=lyrics,
            profanity_count=profanity_count,
            slur_count=slur_count,
        )
        threshold = max(
            1,
            int(os.environ.get("FURATIC_PROFANITY_HOLD_THRESHOLD", "10")),
        )
        if slur_count or profanity_count >= threshold:
            updates.update(
                review_status="pending",
                review_reason="Detected slur" if slur_count else "Heavy profanity",
            )
    except (requests.RequestException, TypeError, ValueError, AttributeError) as error:
        # Lyrics are optional. A provider outage must release the analysis gate
        # and wake playback rather than leaving a song stuck forever.
        LOGGER.warning("lyrics analysis failed for queue song %s: %s", queue_key, error)
    finally:
        models.QueuedSong.objects.filter(id=queue_key).update(**updates)
        from core.musiq import musiq, playback

        playback.queue_changed.set()
        musiq.update_state()
