"""Bounded text/URL validation shared by song submissions and suggestions."""
import re
from urllib.parse import parse_qs, urlsplit

MAX_MUSIC_QUERY = 2048
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com",
                  "music.youtube.com", "youtu.be", "www.youtu.be",
                  "youtube-nocookie.com", "www.youtube-nocookie.com"}


def youtube_video_id(value):
    """Parse only supported YouTube URLs; an ID can never become a file path."""
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _YOUTUBE_HOSTS:
        raise ValueError("Please paste a valid YouTube or YouTube Music link.")
    if parsed.username is not None or parsed.password is not None or parsed.port not in (None, 80, 443):
        raise ValueError("Please paste a standard YouTube link without login details or a custom port.")
    parts = parsed.path.strip("/").split("/")
    if parsed.hostname in {"youtu.be", "www.youtu.be"} and len(parts) == 1:
        video_id = parts[0]
    elif len(parts) == 2 and parts[0] in {"shorts", "embed", "live"}:
        video_id = parts[1]
    elif parsed.path.rstrip("/") == "/watch":
        values = parse_qs(parsed.query, max_num_fields=50).get("v", [])
        video_id = values[0] if len(values) == 1 else ""
    else:
        video_id = ""
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("That YouTube link does not contain a valid video ID.")
    return video_id


def music_query(value, *, partial=False, playlist=False):
    if not isinstance(value, str) or len(value) > MAX_MUSIC_QUERY:
        raise ValueError("Please keep your search or link under 2,048 characters.")
    if _CONTROLS.search(value):
        raise ValueError("Please remove the unsupported control characters from your search.")
    value = " ".join(value.split())
    if not value:
        if partial:
            return ""
        raise ValueError("Enter a song name or a YouTube link.")
    if re.match(r"(?i)^(?:file|javascript|data|vbscript|ftp):", value):
        raise ValueError("Enter a song name or an HTTP/HTTPS music link.")
    if re.match(r"(?i)^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)/", value):
        value = "https://" + value
    if "://" not in value:
        return value
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or " " in value or "\\" in value:
            raise ValueError("Please paste a valid HTTP/HTTPS music link.")
        if parsed.username is not None or parsed.password is not None or parsed.port not in (None, 80, 443):
            raise ValueError("Please paste a standard music link without login details or a custom port.")
        host = parsed.hostname.lower()
        if host in _YOUTUBE_HOSTS:
            if partial:
                return value
            if playlist and parsed.path.rstrip("/") == "/playlist":
                ids = parse_qs(parsed.query, max_num_fields=50).get("list", [])
                if len(ids) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{10,100}", ids[0]):
                    raise ValueError("That YouTube playlist link is incomplete.")
                return "https://www.youtube.com/playlist?list=" + ids[0]
            video_id = youtube_video_id(value)
            if playlist:
                return value
            return "https://www.youtube.com/watch?v=" + video_id
        # Other existing providers retain their own availability checks. A
        # lookalike YouTube host must never be accepted as a YouTube endpoint.
        if "youtube" in host or "youtu.be" in host:
            raise ValueError("Please use a link from youtube.com, music.youtube.com or youtu.be.")
    except (TypeError, UnicodeError) as error:
        raise ValueError("Please paste a valid music link.") from error
    return value
