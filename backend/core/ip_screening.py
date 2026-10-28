"""Runtime IP screening with local IPv4 blocklists and GetIPIntel."""
from __future__ import annotations

import ipaddress
import datetime
import threading
import json
import logging
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

from django.conf import settings as conf
from django.core.files.uploadedfile import UploadedFile

from core import redis
from core.settings import storage

logger = logging.getLogger(__name__)

BLOCKLIST_SETTING_KEY = "ip_blocklist_sources"

DEFAULT_BLOCKLIST_ID = "x4bnet-datacenter-ipv4"
DEFAULT_BLOCKLIST_NAME = "X4BNet Datacenter IPv4"
DEFAULT_BLOCKLIST_FILENAME = "x4bnet_datacenter_ipv4.txt"

DECISION_KEY_PREFIX = "ip-screen:decision:"
DEFER_KEY_PREFIX = "ip-screen:defer:"
DAY_USAGE_KEY_PREFIX = "ip-screen:usage:day:"
MINUTE_USAGE_KEY_PREFIX = "ip-screen:usage:minute:"

DEFAULT_DEFER_TTL_SECONDS = 15 * 60
PERSISTENT_TTL = 30 * 24 * 60 * 60
_LOOKUP_LOCKS = [threading.Lock() for _ in range(64)]
_next_prune = 0.0

_COMPILED_CACHE: Dict[str, Any] = {
    "signature": None,
    "sources": [],
}


def _normalize_ipv4(value: str) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return ""
    if ip.version != 4:
        return ""
    return ip.compressed


def _blocklist_dir() -> pathlib.Path:
    path = pathlib.Path(conf.FURATIC_IP_BLOCKLIST_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _default_blocklist_path() -> pathlib.Path:
    return _blocklist_dir() / DEFAULT_BLOCKLIST_FILENAME


def _normalize_separator(value: Any) -> str:
    value = str(value or "auto").strip().lower()
    if value in {"auto", "newline", "comma", "whitespace"}:
        return value
    return "auto"


def _normalize_entry_type(value: Any) -> str:
    value = str(value or "auto").strip().lower()
    if value in {"auto", "single", "cidr", "range"}:
        return value
    return "auto"


def _load_sources() -> List[Dict[str, Any]]:
    raw = str(storage.get(BLOCKLIST_SETTING_KEY) or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Invalid ip_blocklist_sources setting; ignoring it")
        return []
    if not isinstance(data, list):
        return []

    cleaned: List[Dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue

        source_id = str(item.get("id") or "").strip()
        stored_filename = os.path.basename(str(item.get("stored_filename") or "").strip())
        if not source_id or not stored_filename:
            continue

        cleaned.append(
            {
                "id": source_id,
                "name": str(item.get("name") or source_id).strip(),
                "stored_filename": stored_filename,
                "separator": _normalize_separator(item.get("separator")),
                "entry_type": _normalize_entry_type(item.get("entry_type")),
                "source_kind": str(item.get("source_kind") or "upload").strip() or "upload",
                "source_url": str(item.get("source_url") or "").strip(),
                "created_at": int(item.get("created_at") or time.time()),
                "entry_count": int(item.get("entry_count") or 0),
            }
        )
    return cleaned


def _save_sources(sources: List[Dict[str, Any]]) -> None:
    storage.put(BLOCKLIST_SETTING_KEY, json.dumps(sources))
    invalidate_blocklist_cache()


def invalidate_blocklist_cache() -> None:
    # A moderator's changed blocklist takes effect immediately, including for
    # addresses whose successful API result is stored for a month.
    for key in redis.connection.scan_iter(match=DECISION_KEY_PREFIX + '*', count=200):
        redis.connection.delete(key)
    _COMPILED_CACHE["signature"] = None
    _COMPILED_CACHE["sources"] = []


def _strip_comments(text: str) -> str:
    cleaned_lines: List[str] = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            cleaned_lines.append(line)
    return "\n".join(cleaned_lines)


def _split_tokens(text: str, separator: str) -> List[str]:
    cleaned = _strip_comments(text)
    if not cleaned:
        return []

    if separator == "newline":
        return [part.strip() for part in cleaned.splitlines() if part.strip()]
    if separator == "comma":
        return [part.strip() for part in cleaned.split(",") if part.strip()]
    if separator == "whitespace":
        return [part.strip() for part in re.split(r"\s+", cleaned) if part.strip()]

    return [part.strip() for part in re.split(r"[\s,]+", cleaned) if part.strip()]


def _parse_token_to_networks(token: str, entry_type: str) -> List[ipaddress.IPv4Network]:
    token = token.strip()
    if not token:
        return []

    mode = entry_type
    if mode == "auto":
        if "-" in token and "/" not in token:
            mode = "range"
        elif "/" in token:
            mode = "cidr"
        else:
            mode = "single"

    if mode == "single":
        ip = ipaddress.ip_address(token)
        if ip.version != 4:
            raise ValueError("Only IPv4 blocklists are supported")
        return [ipaddress.ip_network(f"{ip.compressed}/32", strict=False)]

    if mode == "cidr":
        network = ipaddress.ip_network(token, strict=False)
        if network.version != 4:
            raise ValueError("Only IPv4 blocklists are supported")
        return [network]

    if mode == "range":
        if "-" not in token:
            raise ValueError(f"Invalid IPv4 range: {token}")
        start_raw, end_raw = token.split("-", 1)
        start_ip = ipaddress.ip_address(start_raw.strip())
        end_ip = ipaddress.ip_address(end_raw.strip())
        if start_ip.version != 4 or end_ip.version != 4:
            raise ValueError("Only IPv4 blocklists are supported")
        if int(start_ip) > int(end_ip):
            raise ValueError(f"Invalid IPv4 range: {token}")
        return list(ipaddress.summarize_address_range(start_ip, end_ip))

    raise ValueError(f"Unsupported entry type: {entry_type}")


def parse_blocklist_text(
    text: str,
    separator: str = "auto",
    entry_type: str = "auto",
) -> Tuple[List[ipaddress.IPv4Network], int]:
    tokens = _split_tokens(text, _normalize_separator(separator))
    networks: List[ipaddress.IPv4Network] = []
    invalid_tokens = 0

    for token in tokens:
        try:
            networks.extend(
                _parse_token_to_networks(token, _normalize_entry_type(entry_type))
            )
        except ValueError:
            invalid_tokens += 1

    if not networks:
        raise ValueError(
            "No valid IPv4 addresses or ranges were found in this blocklist"
        )

    return networks, invalid_tokens


def _source_path(source: Dict[str, Any]) -> pathlib.Path:
    return _blocklist_dir() / os.path.basename(str(source["stored_filename"]))


def _build_signature(sources: List[Dict[str, Any]]) -> Tuple[Tuple[Any, ...], ...]:
    signature: List[Tuple[Any, ...]] = []
    for source in sources:
        path = _source_path(source)
        try:
            stat = path.stat()
            mtime_ns = stat.st_mtime_ns
            size = stat.st_size
        except FileNotFoundError:
            mtime_ns = -1
            size = -1
        signature.append(
            (
                source["id"],
                source["stored_filename"],
                source["separator"],
                source["entry_type"],
                mtime_ns,
                size,
            )
        )
    return tuple(signature)


def _ensure_default_blocklist_registered() -> None:
    if storage.get("ip_blocklist_bootstrap_done"):
        return

    default_path = _default_blocklist_path()
    if not default_path.exists():
        return

    sources = _load_sources()
    if not any(source["stored_filename"] == DEFAULT_BLOCKLIST_FILENAME for source in sources):
        sources.append(
            {
                "id": DEFAULT_BLOCKLIST_ID,
                "name": DEFAULT_BLOCKLIST_NAME,
                "stored_filename": DEFAULT_BLOCKLIST_FILENAME,
                "separator": "newline",
                "entry_type": "cidr",
                "source_kind": "seed",
                "source_url": "https://raw.githubusercontent.com/X4BNet/lists_vpn/refs/heads/main/output/datacenter/ipv4.txt",
                "created_at": int(time.time()),
                "entry_count": 0,
            }
        )
        _save_sources(sources)

    storage.put("ip_blocklist_bootstrap_done", True)


def _compiled_sources() -> List[Dict[str, Any]]:
    _ensure_default_blocklist_registered()
    sources = _load_sources()
    signature = _build_signature(sources)
    if _COMPILED_CACHE["signature"] == signature:
        return _COMPILED_CACHE["sources"]

    compiled: List[Dict[str, Any]] = []
    for source in sources:
        path = _source_path(source)
        if not path.exists():
            logger.warning("Skipping missing blocklist file: %s", path)
            continue

        try:
            text = path.read_text(encoding="utf-8-sig")
            networks, invalid_tokens = parse_blocklist_text(
                text,
                separator=source["separator"],
                entry_type=source["entry_type"],
            )
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Unable to load blocklist %s: %s", path, exc)
            continue

        compiled.append(
            {
                **source,
                "path": str(path),
                "entry_count": len(networks),
                "invalid_tokens": invalid_tokens,
                "networks": networks,
            }
        )

    _COMPILED_CACHE["signature"] = signature
    _COMPILED_CACHE["sources"] = compiled
    return compiled


def list_blocklists() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for source in _compiled_sources():
        items.append(
            {
                "id": source["id"],
                "name": source["name"],
                "storedFilename": source["stored_filename"],
                "separator": source["separator"],
                "entryType": source["entry_type"],
                "sourceKind": source["source_kind"],
                "sourceUrl": source["source_url"],
                "createdAt": source["created_at"],
                "entryCount": source["entry_count"],
                "invalidTokens": source["invalid_tokens"],
            }
        )
    return items


def _read_uploaded_file(uploaded_file: UploadedFile) -> str:
    chunks = []
    for chunk in uploaded_file.chunks():
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8-sig", errors="replace")


def _download_source_url(source_url: str) -> str:
    request = urllib.request.Request(source_url, headers={"User-Agent": "FURATIC/1.0"})
    with urllib.request.urlopen(
        request,
        timeout=conf.FURATIC_IP_INTEL_TIMEOUT_SECONDS,
    ) as response:
        return response.read().decode("utf-8-sig", errors="replace")


def _make_stored_filename(name: str, original_name: str = "") -> str:
    stem_source = name or pathlib.Path(original_name or "blocklist").stem or "blocklist"
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem_source).strip("_").lower()
    if not stem:
        stem = "blocklist"
    return f"{stem}_{uuid.uuid4().hex[:12]}.txt"


def add_blocklist(
    *,
    name: str,
    separator: str,
    entry_type: str,
    uploaded_file: Optional[UploadedFile] = None,
    source_url: str = "",
) -> Dict[str, Any]:
    separator = _normalize_separator(separator)
    entry_type = _normalize_entry_type(entry_type)
    name = str(name or "").strip()
    source_url = str(source_url or "").strip()

    if uploaded_file is None and not source_url:
        raise ValueError("Upload a text file or provide a URL")

    if uploaded_file is not None and source_url:
        raise ValueError("Choose either a file upload or a URL, not both")

    if uploaded_file is not None:
        text = _read_uploaded_file(uploaded_file)
        original_name = getattr(uploaded_file, "name", "")
        source_kind = "upload"
    else:
        text = _download_source_url(source_url)
        original_name = pathlib.Path(urllib.parse.urlparse(source_url).path).name
        source_kind = "url"

    networks, invalid_tokens = parse_blocklist_text(
        text,
        separator=separator,
        entry_type=entry_type,
    )

    if not name:
        name = pathlib.Path(original_name or "blocklist").stem or "blocklist"

    stored_filename = _make_stored_filename(name, original_name)
    path = _blocklist_dir() / stored_filename
    path.write_text(text, encoding="utf-8")

    source = {
        "id": uuid.uuid4().hex,
        "name": name,
        "stored_filename": stored_filename,
        "separator": separator,
        "entry_type": entry_type,
        "source_kind": source_kind,
        "source_url": source_url,
        "created_at": int(time.time()),
        "entry_count": len(networks),
    }

    sources = _load_sources()
    sources.append(source)
    _save_sources(sources)

    return {
        "id": source["id"],
        "name": source["name"],
        "storedFilename": source["stored_filename"],
        "separator": source["separator"],
        "entryType": source["entry_type"],
        "sourceKind": source["source_kind"],
        "sourceUrl": source["source_url"],
        "createdAt": source["created_at"],
        "entryCount": source["entry_count"],
        "invalidTokens": invalid_tokens,
    }


def rename_blocklist(source_id: str, new_name: str) -> Dict[str, Any]:
    source_id = str(source_id or "").strip()
    new_name = str(new_name or "").strip()

    if not source_id:
        raise ValueError("Missing blocklist id")
    if not new_name:
        raise ValueError("Missing blocklist name")

    sources = _load_sources()
    for source in sources:
        if source["id"] == source_id:
            source["name"] = new_name
            _save_sources(sources)
            return {"id": source["id"], "name": source["name"]}

    raise ValueError("Blocklist not found")


def remove_blocklist(source_id: str) -> str:
    source_id = str(source_id or "").strip()
    if not source_id:
        raise ValueError("Missing blocklist id")

    sources = _load_sources()
    kept: List[Dict[str, Any]] = []
    removed: Optional[Dict[str, Any]] = None

    for source in sources:
        if source["id"] == source_id:
            removed = source
        else:
            kept.append(source)

    if removed is None:
        raise ValueError("Blocklist not found")

    try:
        _source_path(removed).unlink(missing_ok=True)
    except TypeError:
        path = _source_path(removed)
        if path.exists():
            path.unlink()

    _save_sources(kept)
    return removed["name"]


def find_matching_blocklist(ip: str) -> Optional[Dict[str, Any]]:
    normalized = _normalize_ipv4(ip)
    if not normalized:
        return None

    ip_obj = ipaddress.ip_address(normalized)
    for source in _compiled_sources():
        for network in source["networks"]:
            if ip_obj in network:
                return {
                    "id": source["id"],
                    "name": source["name"],
                    "network": str(network),
                    "sourceKind": source["source_kind"],
                }
    return None


def _decision_key(ip: str) -> str:
    return f"{DECISION_KEY_PREFIX}{ip}"


def _defer_key(ip: str) -> str:
    return f"{DEFER_KEY_PREFIX}{ip}"


def _load_cached_decision(ip: str) -> Optional[Dict[str, Any]]:
    raw = redis.connection.get(_decision_key(ip))
    if not raw:
        from core.models import IpScreenDecision
        from django.utils import timezone
        global _next_prune
        if time.monotonic() >= _next_prune:
            _next_prune = time.monotonic() + 3600
            IpScreenDecision.objects.filter(expires_at__lte=timezone.now()).delete()
        row = IpScreenDecision.objects.filter(ip=ip, expires_at__gt=timezone.now()).first()
        if row:
            value = row.decision
            # A changed API policy is re-evaluated instead of using an old verdict.
            if value.get('_policy') != _policy():
                return None
            if not value.get('blocked') and find_matching_blocklist(ip):
                return None
            ttl = max(1, int((row.expires_at - timezone.now()).total_seconds()))
            redis.connection.set(_decision_key(ip), json.dumps(value), ex=ttl)
            return dict(value)
        return None

    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None

    if not isinstance(value, dict):
        return None
    if value.get('reason') in {'api', 'allow'} and value.get('_policy') != _policy():
        return None
    return value


def _policy():
    return [str(conf.FURATIC_IP_INTEL_FLAGS), str(conf.FURATIC_IP_INTEL_BLOCK_THRESHOLD)]


def _store_decision(ip: str, value: Dict[str, Any], ttl_seconds: int) -> None:
    # Persist only successful API verdicts, including residential/allow results.
    # Outages and budget deferrals must never become month-long decisions.
    global _next_prune
    if value.get("reason") in {"api", "allow"}:
        value['_policy'] = _policy()
        from core.models import IpScreenDecision
        from django.utils import timezone
        ttl_seconds = PERSISTENT_TTL
        IpScreenDecision.objects.update_or_create(ip=ip, defaults={
            "decision": value, "expires_at": timezone.now() + datetime.timedelta(seconds=ttl_seconds),
        })
        if time.monotonic() >= _next_prune:
            _next_prune = time.monotonic() + 3600
            IpScreenDecision.objects.filter(expires_at__lte=timezone.now()).delete()
    redis.connection.set(_decision_key(ip), json.dumps(value), ex=ttl_seconds)


def _set_deferred(ip: str, reason: str) -> None:
    redis.connection.set(_defer_key(ip), reason, ex=DEFAULT_DEFER_TTL_SECONDS)


def _is_deferred(ip: str) -> bool:
    return bool(redis.connection.get(_defer_key(ip)))


def _usage_day_key(now: Optional[float] = None) -> str:
    now = now or time.time()
    return f"{DAY_USAGE_KEY_PREFIX}{time.strftime('%Y%m%d', time.gmtime(now))}"


def _usage_minute_key(now: Optional[float] = None) -> str:
    now = now or time.time()
    return f"{MINUTE_USAGE_KEY_PREFIX}{time.strftime('%Y%m%d%H%M', time.gmtime(now))}"


def _api_budget_snapshot(now: Optional[float] = None) -> Dict[str, int]:
    now = now or time.time()
    day_key = _usage_day_key(now)
    minute_key = _usage_minute_key(now)
    daily_used = int(redis.connection.get(day_key) or 0)
    minute_used = int(redis.connection.get(minute_key) or 0)
    return {
        "daily_used": daily_used,
        "daily_limit": int(conf.FURATIC_IP_INTEL_DAILY_LIMIT),
        "minute_used": minute_used,
        "minute_limit": int(conf.FURATIC_IP_INTEL_MINUTE_LIMIT),
    }


def _reserve_api_budget() -> bool:
    now = time.time()
    snapshot = _api_budget_snapshot(now)
    if snapshot["daily_used"] >= snapshot["daily_limit"]:
        return False
    if snapshot["minute_used"] >= snapshot["minute_limit"]:
        return False

    day_key = _usage_day_key(now)
    minute_key = _usage_minute_key(now)

    pipe = redis.connection.pipeline()
    pipe.incr(day_key)
    pipe.expire(day_key, 3 * 24 * 60 * 60)
    pipe.incr(minute_key)
    pipe.expire(minute_key, 2 * 60)
    pipe.execute()
    return True


def _call_getipintel(ip: str) -> Dict[str, Any]:
    params = {
        "ip": ip,
        "contact": conf.FURATIC_IP_INTEL_CONTACT_EMAIL,
        "format": "json",
        "flags": conf.FURATIC_IP_INTEL_FLAGS,
        "oflags": "i",
    }
    url = "http://check.getipintel.net/check.php?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "FURATIC/1.0"})
    with urllib.request.urlopen(
        request,
        timeout=conf.FURATIC_IP_INTEL_TIMEOUT_SECONDS,
    ) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def get_runtime_state() -> Dict[str, Any]:
    snapshot = _api_budget_snapshot()
    return {
        "enabled": bool(conf.FURATIC_IP_INTEL_ENABLED),
        "contactConfigured": bool(conf.FURATIC_IP_INTEL_CONTACT_EMAIL),
        "flags": conf.FURATIC_IP_INTEL_FLAGS,
        "dailyUsed": snapshot["daily_used"],
        "dailyLimit": snapshot["daily_limit"],
        "minuteUsed": snapshot["minute_used"],
        "minuteLimit": snapshot["minute_limit"],
        "cacheTtlSeconds": PERSISTENT_TTL,
    }


def _evaluate_ip(ip: str, *, allow_api: bool) -> Dict[str, Any]:
    normalized = _normalize_ipv4(ip)
    if not normalized:
        return {
            "blocked": False,
            "reason": "invalid-ip",
            "ip": "",
            "cached": False,
            "newlyBlocked": False,
        }

    cached = _load_cached_decision(normalized)
    if cached is not None:
        cached["cached"] = True
        cached["newlyBlocked"] = False
        return cached

    match = find_matching_blocklist(normalized)
    if match is not None:
        decision = {
            "blocked": True,
            "reason": "blocklist",
            "ip": normalized,
            "source": match,
            "cached": False,
            "newlyBlocked": True,
        }
        _store_decision(
            normalized,
            decision,
            int(conf.FURATIC_IP_SCREEN_CACHE_TTL_SECONDS),
        )
        return decision

    if not allow_api:
        return {
            "blocked": False,
            "reason": "afterhours-skip",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    if not conf.FURATIC_IP_INTEL_ENABLED:
        return {
            "blocked": False,
            "reason": "api-disabled",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    if not conf.FURATIC_IP_INTEL_CONTACT_EMAIL:
        logger.warning("ip_screening skip ip=%s reason=missing-contact-email", normalized)
        return {
            "blocked": False,
            "reason": "missing-contact-email",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    if _is_deferred(normalized):
        return {
            "blocked": False,
            "reason": "api-deferred",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    if not _reserve_api_budget():
        logger.warning("ip_screening skip ip=%s reason=api-budget-exhausted", normalized)
        _set_deferred(normalized, "budget-exhausted")
        return {
            "blocked": False,
            "reason": "budget-exhausted",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    try:
        payload = _call_getipintel(normalized)
    except urllib.error.HTTPError as exc:
        logger.warning("GetIPIntel HTTP error for %s: %s", normalized, exc)
        _set_deferred(normalized, f"http-{exc.code}")
        return {
            "blocked": False,
            "reason": f"http-{exc.code}",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("GetIPIntel lookup failed for %s: %s", normalized, exc)
        _set_deferred(normalized, "lookup-error")
        return {
            "blocked": False,
            "reason": "lookup-error",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
        }

    status = str(payload.get("status") or "").lower()
    result_raw = str(payload.get("result") or "")
    vpn_type = str(payload.get("VPNType") or "none")
    i_cloud_relay = str(payload.get("iCloudRelayEgress") or "0")
    google_one_vpn = str(payload.get("GoogleOneVPN") or "0")

    if status != "success":
        _set_deferred(normalized, result_raw or "api-error")
        return {
            "blocked": False,
            "reason": result_raw or "api-error",
            "ip": normalized,
            "cached": False,
            "newlyBlocked": False,
            "api": payload,
        }

    blocked = False
    if conf.FURATIC_IP_INTEL_FLAGS == "m":
        blocked = result_raw == "1"
    else:
        try:
            blocked = float(result_raw) >= float(conf.FURATIC_IP_INTEL_BLOCK_THRESHOLD)
        except (TypeError, ValueError):
            blocked = False

    if not blocked and vpn_type not in {"", "none"}:
        blocked = True
    if not blocked and (i_cloud_relay == "1" or google_one_vpn == "1"):
        blocked = True

    decision = {
        "blocked": blocked,
        "reason": "api" if blocked else "allow",
        "ip": normalized,
        "cached": False,
        "newlyBlocked": blocked,
        "api": {
            "result": result_raw,
            "vpnType": vpn_type,
            "iCloudRelayEgress": i_cloud_relay,
            "GoogleOneVPN": google_one_vpn,
            "flags": conf.FURATIC_IP_INTEL_FLAGS,
        },
    }
    _store_decision(
        normalized,
        decision,
        int(conf.FURATIC_IP_SCREEN_CACHE_TTL_SECONDS),
    )

    logger.info(
        "ip_screening result ip=%s blocked=%s result=%s vpnType=%s iCloudRelay=%s GoogleOneVPN=%s",
        normalized,
        blocked,
        result_raw,
        vpn_type,
        i_cloud_relay,
        google_one_vpn,
    )
    return decision



def evaluate_ip(ip: str, *, allow_api: bool) -> Dict[str, Any]:
    normalized = _normalize_ipv4(ip)
    cached = _load_cached_decision(normalized) if normalized else None
    if cached is not None:
        return {**cached, "cached": True, "newlyBlocked": False}
    # Coalesce simultaneous first visits from the same address; bounded locks.
    with _LOOKUP_LOCKS[hash(normalized) % len(_LOOKUP_LOCKS)]:
        return _evaluate_ip(normalized, allow_api=allow_api)
