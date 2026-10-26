"""File logging that never sleeps on playback or HTTP threads."""
from __future__ import annotations

from collections import deque
import logging
import logging.handlers
import os
import time
from pathlib import Path

from core.safe_files import is_transient_file_error


class WindowsSafeRotatingFileHandler(logging.handlers.RotatingFileHandler):
    """Defer locked-file rotation; retain a bounded backlog until writes resume.

    Keep the existing configuration arguments compatible. A Windows sharing
    violation must never start nested retry sleeps while holding Handler.lock.
    """

    def __init__(self, filename, mode="a", maxBytes=0, backupCount=0,
                 encoding=None, delay=False, errors=None, retry_attempts=8,
                 retry_initial_delay_seconds=0.25, retry_max_delay_seconds=2.0):
        self.retry_attempts = retry_attempts
        self.retry_initial_delay_seconds = retry_initial_delay_seconds
        self.retry_max_delay_seconds = retry_max_delay_seconds
        self._retry_at = 0.0
        self._rotation_retry_at = 0.0
        self._pending_lines = deque(maxlen=256)
        self._dropped_lines = 0
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        # Delay opening so a transient lock at startup is handled by emit too.
        super().__init__(filename, mode=mode, maxBytes=maxBytes,
                         backupCount=backupCount, encoding=encoding,
                         delay=True, errors=errors)

    def _close_stream(self):
        stream, self.stream = self.stream, None
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass

    def rotate(self, source, dest):
        if os.path.exists(source):
            os.replace(source, dest)

    def emit(self, record):
        try:
            line = self.format(record) + self.terminator
            if len(self._pending_lines) == self._pending_lines.maxlen:
                self._dropped_lines += 1
            self._pending_lines.append(line)
            now = time.monotonic()
            if now < self._retry_at:
                return
            if now >= self._rotation_retry_at and self.shouldRollover(record):
                try:
                    super().doRollover()
                except OSError as error:
                    if not is_transient_file_error(error):
                        raise
                    self._close_stream()
                    self._rotation_retry_at = now + max(0.25, self.retry_max_delay_seconds)
                    # Append to the existing log until its rename becomes safe.
            if self.stream is None:
                self.stream = self._open()
            if self._dropped_lines:
                self.stream.write(f"WARNING: {self._dropped_lines} log records could not be retained while the log file was unavailable.\n")
                self.stream.flush()
                self._dropped_lines = 0
            # Bound work under the logging lock even after a long file outage.
            for _ in range(min(16, len(self._pending_lines))):
                self.stream.write(self._pending_lines[0])
                self.stream.flush()
                self._pending_lines.popleft()
            self._retry_at = 0.0
        except OSError as error:
            self._close_stream()
            self._retry_at = time.monotonic() + max(0.25, self.retry_max_delay_seconds)
            if not is_transient_file_error(error):
                self.handleError(record)
        except Exception:
            self.handleError(record)
