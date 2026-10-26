"""Retry safe filesystem helpers for Windows transient file locks from Windows Defender or other software.

Windows Defender, OBS, indexing, backup tools, and Explorer previews can
temporarily lock files. These helpers keep those transient locks from taking
down request handlers, playback tasks, logging, and other updates.
"""

from __future__ import annotations

import errno
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, TypeVar

LOGGER = logging.getLogger(__name__)

T = TypeVar("T")

# Common Windows transient file lock / sharing violation errors.
# 5: Access denied
# 32: Sharing violation / file in use by another process
# 33: Lock violation
# 80: File exists
# 183: Cannot create a file when that file already exists
_TRANSIENT_WINERRORS = {5, 32, 33, 80, 183}
_TRANSIENT_ERRNOS = {errno.EACCES, errno.EPERM, errno.EBUSY}


def is_transient_file_error(exc: BaseException) -> bool:
    """Return True when an OS error is likely a temporary filesystem lock."""

    if not isinstance(exc, OSError):
        return False

    winerror = getattr(exc, "winerror", None)
    if winerror in _TRANSIENT_WINERRORS:
        return True

    return exc.errno in _TRANSIENT_ERRNOS


def retry_file_operation(
    operation: Callable[[], T],
    *,
    description: str,
    attempts: int = 8,
    initial_delay_seconds: float = 0.25,
    max_delay_seconds: float = 2.0,
    logger: logging.Logger | None = None,
) -> T:
    """Run a filesystem operation with bounded retry/backoff.

    This is intentionally conservative:
    - only transient looking OSError/PermissionError cases are retried
    - retry time is bounded
    - non-filesystem bugs still raise immediately
    """

    active_logger = logger or LOGGER
    delay = initial_delay_seconds
    last_error: OSError | None = None

    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except OSError as exc:
            if not is_transient_file_error(exc):
                raise

            last_error = exc
            if attempt >= attempts:
                break

            active_logger.debug(
                "%s failed because the file appears temporarily locked "
                "(attempt %s/%s): %s",
                description,
                attempt,
                attempts,
                exc,
            )
            time.sleep(delay)
            delay = min(max_delay_seconds, delay * 1.5)

    assert last_error is not None
    raise last_error


def atomic_write_text(
    path: Path,
    text: str,
    *,
    encoding: str = "utf-8",
    attempts: int = 8,
    logger: logging.Logger | None = None,
) -> None:
    """Atomically write text with retry safe replace semantics.

    The temp file is created beside the target so os.replace stays atomic on
    the same filesystem. A unique temp name avoids collisions between workers.
    """

    path = Path(path)
    active_logger = logger or LOGGER

    retry_file_operation(
        lambda: path.parent.mkdir(parents=True, exist_ok=True),
        description=f"create directory {path.parent}",
        attempts=attempts,
        logger=active_logger,
    )

    temp_path = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
    )

    try:
        def write_temp() -> None:
            with temp_path.open("w", encoding=encoding) as file:
                file.write(text)
                file.flush()
                os.fsync(file.fileno())

        retry_file_operation(
            write_temp,
            description=f"write temporary file {temp_path}",
            attempts=attempts,
            logger=active_logger,
        )

        retry_file_operation(
            lambda: os.replace(temp_path, path),
            description=f"replace {path}",
            attempts=attempts,
            logger=active_logger,
        )
    finally:
        if temp_path.exists():
            try:
                retry_file_operation(
                    lambda: temp_path.unlink(missing_ok=True),
                    description=f"remove temporary file {temp_path}",
                    attempts=3,
                    logger=active_logger,
                )
            except OSError:
                active_logger.warning(
                    "could not remove temporary file after failed write: %s",
                    temp_path,
                    exc_info=True,
                )


def safe_unlink(
    path: Path,
    *,
    missing_ok: bool = True,
    attempts: int = 8,
    logger: logging.Logger | None = None,
) -> None:
    """Delete a file with retry/backoff for transient Windows locks."""

    path = Path(path)

    retry_file_operation(
        lambda: path.unlink(missing_ok=missing_ok),
        description=f"remove file {path}",
        attempts=attempts,
        logger=logger,
    )



class OptionalFileStatus:
    """Report a persistent output failure once, while retrying fresh state."""
    def __init__(self, name, logger):
        self.name, self.logger = name, logger
        self.first_failure = None
        self.last_report = -float("inf")
        self.reported = False

    def failed(self, error):
        now = time.monotonic()
        if self.first_failure is None:
            self.first_failure = now
        persistent = now - self.first_failure >= 10
        if (persistent or not is_transient_file_error(error)) and now - self.last_report >= 60:
            self.logger.warning("%s unavailable; fresh-state retry continues: %s", self.name, error)
            self.last_report, self.reported = now, True
        else:
            self.logger.debug("%s update deferred: %s", self.name, error)

    def succeeded(self):
        if self.reported:
            self.logger.info("%s updates recovered", self.name)
        self.first_failure, self.last_report, self.reported = None, -float("inf"), False
