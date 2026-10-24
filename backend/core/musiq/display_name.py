"""Conservative, display-only cleanup of external song metadata.

Keep these rules in sync with frontend/ts/musiq/display-name.ts and the shared
fixtures. Never write the result back to a provider, queue, or song record.
"""
import re
import unicodedata

_BRACKETS = re.compile(r"\(([^()]*)\)|\[([^\[\]]*)\]")
_SEPARATOR = re.compile(r"\s+[-–—|]\s+")
_QUALITY = r"(?:music\s+)?(?:hq|hd|flac|lossless|[48]k|\d{3,4}p)"
_JUNK = re.compile(
    r"^(?:(?:(?:official|unofficial)\s+)?"
    r"(?:(?:music|lyric|lyrics)\s+)?(?:video|audio|visuali[sz]er|lyrics?)"
    r"(?:\s+" + _QUALITY + r")?|"
    + _QUALITY + r"(?:[\s/,+–—-]+" + _QUALITY + r")*|"
    r"(?:high[\s-]*speed|sped[\s-]*up)\s*(?:version|ver\.?)?|bonus\s+tracks?)$",
    re.IGNORECASE,
)


def _text(value) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split())


def _key(value: str) -> str:
    return "".join(char for char in value.lower() if char.isalnum())


def _annotations(value: str, credit_keys=()) -> str:
    def replace(match):
        label = (match.group(1) if match.group(1) is not None else match.group(2)).strip()
        credit = re.sub(r"^(?:feat(?:uring)?\.?|ft\.?|with)\s+", "", label, flags=re.IGNORECASE)
        return " " if not label or _JUNK.fullmatch(label) or _key(credit) in credit_keys else match.group(0)

    previous = None
    while previous != value:
        previous, value = value, _BRACKETS.sub(replace, value)
    return _text(value)


def _segments(title: str):
    """Split only outside brackets; a real subtitle can contain a dash."""
    parts, separators = [], []
    start = cursor = depth = 0
    for match in _SEPARATOR.finditer(title):
        for char in title[cursor:match.start()]:
            depth = max(0, depth + (1 if char in "([" else -1 if char in ")]" else 0))
        cursor = match.end()
        if depth:
            continue
        parts.append(title[start:match.start()])
        separators.append(match.group(0))
        start = match.end()
    parts.append(title[start:])
    return parts, separators


def clean_display_names(artist, title) -> tuple[str, str]:
    """Return (artist, title), preserving ambiguous uploader and title credits."""
    raw_title = _text(title)
    title = _annotations(raw_title) or raw_title
    label = _annotations(_text(artist))
    label = re.sub(r"\s*[-–—]\s*Topic$|VEVO$", "", label, flags=re.IGNORECASE).strip()
    credits = []
    seen = {}
    for credit in re.split(r"[,;]", label):
        credit = re.sub(r"\s*[-–—]\s*Topic$|VEVO$", "", credit, flags=re.IGNORECASE).strip()
        key = _key(credit)
        if key and key not in seen:
            seen[key] = len(credits)
            credits.append(credit)

    keys = set(seen)
    if credits:
        keys.update(_key(joiner.join(credits)) for joiner in ("", " x ", " and "))
    title = _annotations(title, keys) or title

    # A separator alone is not evidence that an uploader is the performer.
    # Only move a title credit when its letters/digits match known metadata.
    parts, separators = _segments(title)
    while len(parts) > 1 and _JUNK.fullmatch(parts[-1].strip()):
        parts.pop()
        separators.pop()
    while len(parts) > 1:
        def known_credit(value):
            return _key(value) in keys or all(_key(part) in seen for part in re.split(r"[,;]", value))
        index = 0 if known_credit(parts[0]) else -1 if known_credit(parts[-1]) else None
        if index is None:
            break
        credit = parts.pop(index).strip()
        separators.pop(index)
        for name in re.split(r"[,;]", credit):
            name = name.strip()
            key = _key(name)
            if key in seen:
                old = credits[seen[key]]
                # Recover "Courtney Barnett" from "courtneybarnett" without
                # title-casing deliberate names such as DiGiTAL WiNG or 5oh8.
                if old == old.lower() and (" " in name or name != name.lower()):
                    credits[seen[key]] = name
    title = "".join(part + (separators[i] if i < len(separators) else "") for i, part in enumerate(parts)) or title
    return ", ".join(credits), _text(title)
