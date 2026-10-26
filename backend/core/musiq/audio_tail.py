"""Detect and cache quiet audio tails for downloaded song files."""

from __future__ import annotations

import audioop
import hashlib
import json
import logging
import math
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from django.conf import settings as conf

from core.settings import storage
from core.safe_files import atomic_write_text

logger = logging.getLogger(__name__)

CACHE_FILE = Path(conf.BASE_DIR) / "config" / "audio_tail_cache.json"
CACHE_VERSION = 1
MAX_CACHE_ENTRIES = 512

# Requests and playback only read this bounded cache. Decoding and optional
# persistence belong to at most two workers, with at most eight jobs in flight.
_cache_lock = threading.RLock()
_write_lock = threading.Lock()
_cache = None
_pending = {}
_failed_until = {}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="audio-tail")
_last_cache_warning = -float("inf")
ANALYSIS_TIMEOUT_SECONDS = 60

SAMPLE_RATE = 8000
SAMPLE_WIDTH = 2
CHUNK_SECONDS = 0.25
MINIMUM_ANALYSIS_DURATION_SECONDS = 20.0


@dataclass(frozen=True)
class TailAnalysis:
    effective_duration: float
    original_duration: float
    trimmed_seconds: float
    threshold_db: float


def _setting_float(key: str, fallback: float) -> float:
    try:
        return float(storage.get(key))
    except Exception:  # pylint: disable=broad-except
        return fallback


def enabled() -> bool:
    try:
        return bool(storage.get("silence_tail_skip_enabled"))
    except Exception:  # pylint: disable=broad-except
        return True


def transition_fade_seconds() -> float:
    return max(0.0, _setting_float("song_transition_fade_seconds", 2.0))


def _uri_to_path(uri: str) -> Optional[Path]:
    if not uri:
        return None

    uri = str(uri).strip()
    if not uri:
        return None

    if uri.startswith("file://"):
        parsed = urlparse(uri)

        if parsed.netloc and not parsed.path:
            raw_path = unquote(parsed.netloc)
        else:
            raw_path = unquote(parsed.path)
            if os.name == "nt" and len(raw_path) >= 3 and raw_path[0] == "/" and raw_path[2] == ":":
                raw_path = raw_path[1:]

        if os.name == "nt":
            raw_path = raw_path.replace("/", "\\")

        return Path(raw_path)

    path = Path(uri)
    if path.exists():
        return path

    return None


def _read_cache() -> dict[str, Any]:
    try:
        with CACHE_FILE.open("r", encoding="utf-8") as infile:
            data = json.load(infile)
    except (FileNotFoundError, json.JSONDecodeError, UnicodeError, OSError):
        return {}

    return data if isinstance(data, dict) else {}


def _cache_age(item):
    try:
        age = float(item.get("analyzed_at", 0))
        return age if math.isfinite(age) else 0.0
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _write_cache(cache: dict[str, Any]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)

    if len(cache) > MAX_CACHE_ENTRIES:
        sorted_items = sorted(
            cache.items(),
            key=lambda item: _cache_age(item[1]),
        )
        cache = dict(sorted_items[-MAX_CACHE_ENTRIES:])

    atomic_write_text(CACHE_FILE, json.dumps(cache, sort_keys=True) + "\n",
                      attempts=2, logger=logger)


def _cache_key(
    path: Path,
    duration: float,
    threshold_db: float,
    min_tail_seconds: float,
    padding_seconds: float,
    start_grace_seconds: float,
) -> str:
    stat = path.stat()
    source = "|".join(
        [
            str(CACHE_VERSION),
            str(path.resolve()),
            str(stat.st_size),
            str(stat.st_mtime_ns),
            f"{float(duration):.3f}",
            f"{threshold_db:.2f}",
            f"{min_tail_seconds:.2f}",
            f"{padding_seconds:.2f}",
            f"{start_grace_seconds:.2f}",
        ]
    )
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _analysis_from_cache_item(item: Any) -> Optional[TailAnalysis]:
    if not isinstance(item, dict):
        return None

    try:
        result = TailAnalysis(
            effective_duration=float(item["effective_duration"]),
            original_duration=float(item["original_duration"]),
            trimmed_seconds=float(item["trimmed_seconds"]),
            threshold_db=float(item["threshold_db"]),
        )
        if not all(math.isfinite(value) for value in (
                result.effective_duration, result.original_duration,
                result.trimmed_seconds, result.threshold_db)):
            return None
        if not 0 <= result.effective_duration <= result.original_duration:
            return None
        return result
    except (KeyError, TypeError, ValueError):
        return None


def _find_ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")


def _dbfs_from_pcm(data: bytes) -> float:
    if not data:
        return -120.0

    if len(data) % SAMPLE_WIDTH:
        data = data[: -(len(data) % SAMPLE_WIDTH)]

    if not data:
        return -120.0

    rms = audioop.rms(data, SAMPLE_WIDTH)
    if rms <= 0:
        return -120.0

    return 20.0 * math.log10(rms / 32768.0)


def _analyze_path(
    path: Path,
    original_duration: float,
    threshold_db: float,
    min_tail_seconds: float,
    padding_seconds: float,
    start_grace_seconds: float,
) -> Optional[TailAnalysis]:
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        logger.info("ffmpeg not found; silence tail detection disabled for %s", path)
        return None

    if original_duration <= MINIMUM_ANALYSIS_DURATION_SECONDS:
        return TailAnalysis(
            effective_duration=original_duration,
            original_duration=original_duration,
            trimmed_seconds=0.0,
            threshold_db=threshold_db,
        )

    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
    ]

    creationflags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW

    process = None
    deadline = None
    timed_out = threading.Event()
    elapsed = 0.0
    last_loud_end = 0.0
    chunk_size = int(SAMPLE_RATE * SAMPLE_WIDTH * CHUNK_SECONDS)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )

        def terminate_stalled_decoder():
            timed_out.set()
            try:
                process.kill()
            except OSError:
                pass

        # read() on a stalled decoder can block before wait(timeout) is reached.
        deadline = threading.Timer(ANALYSIS_TIMEOUT_SECONDS, terminate_stalled_decoder)
        deadline.daemon = True
        deadline.start()

        assert process.stdout is not None

        while True:
            data = process.stdout.read(chunk_size)
            if not data:
                break

            chunk_duration = len(data) / float(SAMPLE_RATE * SAMPLE_WIDTH)
            chunk_end = elapsed + chunk_duration

            if chunk_end >= start_grace_seconds:
                if _dbfs_from_pcm(data) >= threshold_db:
                    last_loud_end = chunk_end

            elapsed = chunk_end

        try:
            process.stdout.close()
        except OSError:
            pass

        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    except Exception as error:  # pylint: disable=broad-except
        logger.warning("audio tail analysis failed for %s: %s", path, error)
        if process is not None and process.poll() is None:
            process.kill()
        return None
    finally:
        if deadline is not None:
            deadline.cancel()
        if process is not None:
            if process.stdout is not None:
                process.stdout.close()
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    if timed_out.is_set() or process.returncode != 0:
        logger.warning("audio tail decoder did not complete; using full song duration: %s", path)
        return None

    if original_duration <= 0 and elapsed > 0:
        original_duration = elapsed

    if original_duration <= 0:
        return None

    if last_loud_end <= 0:
        return TailAnalysis(
            effective_duration=original_duration,
            original_duration=original_duration,
            trimmed_seconds=0.0,
            threshold_db=threshold_db,
        )

    effective_duration = min(
        original_duration,
        max(start_grace_seconds, last_loud_end + padding_seconds),
    )
    trimmed_seconds = max(0.0, original_duration - effective_duration)

    if trimmed_seconds < min_tail_seconds:
        effective_duration = original_duration
        trimmed_seconds = 0.0

    result = TailAnalysis(
        effective_duration=round(effective_duration, 3),
        original_duration=round(original_duration, 3),
        trimmed_seconds=round(trimmed_seconds, 3),
        threshold_db=threshold_db,
    )

    if result.trimmed_seconds > 0:
        logger.info(
            "audio tail detected for %s: original=%.2fs effective=%.2fs trimmed=%.2fs threshold=%.1fdB",
            path,
            result.original_duration,
            result.effective_duration,
            result.trimmed_seconds,
            result.threshold_db,
        )

    return result


def _cache_warning(error) -> None:
    global _last_cache_warning
    now = time.monotonic()
    with _cache_lock:
        if now - _last_cache_warning < 60:
            return
        _last_cache_warning = now
    logger.warning("audio tail cache persistence deferred; analysis remains in memory: %s", error)


def _analyze_job(key, path, arguments):
    try:
        result = _analyze_path(path, *arguments)
        with _cache_lock:
            if result is None:
                _failed_until[key] = time.monotonic() + 60
                while len(_failed_until) > MAX_CACHE_ENTRIES:
                    _failed_until.pop(next(iter(_failed_until)))
                return None
            _cache[key] = {
                "effective_duration": result.effective_duration,
                "original_duration": result.original_duration,
                "trimmed_seconds": result.trimmed_seconds,
                "threshold_db": result.threshold_db,
                "source": str(path), "analyzed_at": time.time(),
            }
            while len(_cache) > MAX_CACHE_ENTRIES:
                oldest = min(_cache, key=lambda k: _cache_age(_cache[k]))
                _cache.pop(oldest)
        # Only decoder workers write. A Windows sharing violation cannot escape
        # into an HTTP request, the OBS ticker, or the playback loop.
        try:
            with _write_lock:
                with _cache_lock:
                    snapshot = dict(_cache)
                _write_cache(snapshot)
        except OSError as error:
            _cache_warning(error)
        return result
    except Exception:
        with _cache_lock:
            _failed_until[key] = time.monotonic() + 60
            while len(_failed_until) > MAX_CACHE_ENTRIES:
                _failed_until.pop(next(iter(_failed_until)))
        logger.exception("optional audio tail analysis failed; using full song duration")
        return None


def _analysis_request(uri: str, duration):
    global _cache
    if not enabled():
        return None, None
    try:
        original = float(duration or 0.0)
        if not math.isfinite(original) or original <= 0:
            return None, None
        path = _uri_to_path(uri)
        if path is None or not path.is_file():
            return None, None
        arguments = (
            original, _setting_float("silence_tail_threshold_db", -45.0),
            max(0.0, _setting_float("silence_tail_min_seconds", 5.0)),
            max(0.0, _setting_float("silence_tail_padding_seconds", 2.0)),
            max(0.0, _setting_float("silence_tail_start_grace_seconds", 10.0)),
        )
        key = _cache_key(path, *arguments)
    except (OSError, ValueError, TypeError):
        return None, None
    with _cache_lock:
        if _cache is None:
            loaded = _read_cache()
            # Do not let malformed optional cache entries break normal playback.
            valid = [(k, v) for k, v in loaded.items()
                     if _analysis_from_cache_item(v) is not None]
            _cache = dict(valid[-MAX_CACHE_ENTRIES:])
        result = _analysis_from_cache_item(_cache.get(key))
        if result is not None:
            return result, None
        if key in _pending:
            return None, _pending[key]
        if _failed_until.get(key, 0) > time.monotonic() or len(_pending) >= 8:
            return None, None
        future = _executor.submit(_analyze_job, key, path, arguments)
        _pending[key] = future
        def completed(done):
            with _cache_lock:
                if _pending.get(key) is done:
                    _pending.pop(key, None)
        future.add_done_callback(completed)
        return None, future


def analyze_and_cache(uri: str, duration: Optional[float]) -> Optional[TailAnalysis]:
    """Precompute in the existing download task; deduplicate concurrent requests."""
    result, future = _analysis_request(uri, duration)
    if result is not None or future is None:
        return result
    try:
        return future.result(timeout=ANALYSIS_TIMEOUT_SECONDS + 5)
    except FutureTimeout:
        return None


def effective_duration_for_song(song) -> float:
    """Nonblocking presentation/playback lookup; optional work stays off this thread."""
    duration = float(getattr(song, "duration", 0.0) or 0.0)
    if not math.isfinite(duration) or duration <= 0:
        return 0.0
    uri = (getattr(song, "internal_url", "") or getattr(song, "stream_url", "")
           or getattr(song, "external_url", ""))
    result, _ = _analysis_request(str(uri or ""), duration)
    return duration if result is None else min(duration, max(0.0, result.effective_duration))
