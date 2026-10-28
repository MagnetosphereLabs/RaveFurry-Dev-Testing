"""Passive system-output capture, with one worker and bounded input storage."""
from __future__ import annotations

import logging
import os
import queue
import select
import shutil
import subprocess
import threading
import time

from .dsp import Analyzer, empty_frame
from .foreground import ForegroundAnalyzer

LOG = logging.getLogger(__name__)


class Capture:
    def __init__(self):
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.frame = empty_frame()
        self.status = "starting"
        self.device = ""
        self.error = ""
        self.kick_offset = self.accent_offset = 0
        self.cloud_offsets = [0] * 4
        self.heartbeat = time.monotonic()
        self.foreground_enabled = True
        self.thread = threading.Thread(target=self._run, name="obs-audio-analysis", daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=3)

    def snapshot(self):
        with self.lock:
            frame = dict(self.frame)
            status, device, error = self.status, self.device, self.error
        now = time.monotonic()
        stale = now - frame["capturedAt"] > .30
        if stale:
            if 'foreground' in frame:
                frame['foreground'] = ForegroundAnalyzer.empty()
            for name in ["level", "bass", "mid", "treble", "activity", "kick", "accent",
                         "rhythmConfidence", "rhythmTempo", "rhythmDrive"]:
                frame[name] = 0.0
            frame["bands"] = [0.0] * 48
            frame["rms"] = [0.0, 0.0]
            frame["peak"] = [0.0, 0.0]
            for name in ("cloudLevels", "cloudBalance", "cloudFlux", "cloudStrength"):
                frame[name] = [0.0] * 4
        frame.update({"serverTime": now, "status": "idle" if stale and status == "capturing" else status,
                      "device": device, "error": error})
        return frame

    def healthy(self):
        return self.thread.is_alive() and time.monotonic() - self.heartbeat < 20

    def set_foreground_active(self, enabled):
        self.foreground_enabled = bool(enabled)

    def _touch(self):
        self.heartbeat = time.monotonic()

    def _foreground_feed(self, state, rate, channels, data, timestamp=None):
        if not self.foreground_enabled:
            state.update(analyzer=None, failed=False)
            return ForegroundAnalyzer.empty()
        if state['failed']:
            return ForegroundAnalyzer.empty()
        try:
            state['analyzer'] = state['analyzer'] or ForegroundAnalyzer(rate, channels)
            return state['analyzer'].feed(data, timestamp)
        except Exception:
            # Optional foreground work must never reopen capture or disturb the
            # already-working background analyzer. Retry after a mode/device reset.
            state.update(analyzer=None, failed=True)
            LOG.warning('Foreground analysis unavailable; background capture continues')
            return ForegroundAnalyzer.empty()

    def _publish(self, frame):
        if frame is not None:
            with self.lock:
                frame = dict(frame)
                # Preserve onset IDs across capture-device recovery.
                frame["kickId"] += self.kick_offset
                frame["accentId"] += self.accent_offset
                frame["cloudIds"] = [value + offset for value, offset in zip(frame["cloudIds"], self.cloud_offsets)]
                self.frame = frame

    def _run(self):
        backoff = 2.0
        while not self.stop_event.is_set():
            self._touch()
            with self.lock:
                self.kick_offset = self.frame["kickId"]
                self.accent_offset = self.frame["accentId"]
                self.cloud_offsets = list(self.frame["cloudIds"])
            try:
                if os.name == "nt":
                    self._windows()
                elif os.name == "posix":
                    self._linux()
                else:
                    raise RuntimeError("System-output capture is supported on Windows and Linux")
                backoff = 2.0
            except Exception as error:
                with self.lock:
                    self.status = "error"
                    self.error = str(error)[:200]
                LOG.warning("Audio capture unavailable: %s", error)
                # Retry capture only. Never signal the playback/web process.
                deadline = time.monotonic() + backoff
                while not self.stop_event.is_set() and time.monotonic() < deadline:
                    self._touch()
                    self.stop_event.wait(min(.5, max(0, deadline - time.monotonic())))
                backoff = min(30, backoff * 2)

    def _windows(self):
        import pyaudiowpatch as audio

        packets = queue.Queue(maxsize=4)
        def callback(data, frame_count, time_info, flags):
            if self.stop_event.is_set():
                return None, audio.paComplete
            item = (data, time.monotonic())
            try:
                packets.put_nowait(item)
            except queue.Full:
                try:
                    packets.get_nowait()
                except queue.Empty:
                    pass
                try:
                    packets.put_nowait(item)
                except queue.Full:
                    pass
            return None, audio.paContinue

        # Both objects close on every exit, including a device failure.
        with audio.PyAudio() as manager:
            selection = os.environ.get("FURATIC_VISUALIZER_DEVICE", "").strip()
            device = (manager.get_wasapi_loopback_analogue_by_index(int(selection))
                      if selection else manager.get_default_wasapi_loopback())
            channels = min(8, max(1, int(device["maxInputChannels"])))
            rate = int(device["defaultSampleRate"])
            analyzer = Analyzer(rate, channels)
            foreground = {'analyzer': None, 'failed': False}
            with manager.open(format=audio.paFloat32, channels=channels, rate=rate,
                              input=True, output=False, input_device_index=device["index"],
                              frames_per_buffer=512, stream_callback=callback) as stream:
                with self.lock:
                    self.device = str(device["name"])
                    self.status, self.error = "capturing", ""
                while not self.stop_event.is_set():
                    self._touch()
                    try:
                        data, timestamp = packets.get(timeout=.10)
                        features = self._foreground_feed(foreground, rate, channels, data, timestamp)
                        frame = analyzer.feed(data, timestamp)
                        if frame is not None:
                            self._publish({**frame, 'foreground': features})
                    except queue.Empty:
                        # Idle loopback is healthy. Reopen only an inactive stream.
                        if not stream.is_active():
                            raise RuntimeError("WASAPI capture stream stopped")

    def _linux(self):
        executable = shutil.which("parec")
        if not executable:
            raise RuntimeError("Linux audio analysis needs parec (pulseaudio-utils) and an output monitor")
        device = os.environ.get("FURATIC_VISUALIZER_DEVICE", "@DEFAULT_MONITOR@")
        analyzer = Analyzer(48000, 2)
        foreground = {'analyzer': None, 'failed': False}
        process = subprocess.Popen(
            [executable, "--raw", "--format=float32le", "--rate=48000", "--channels=2",
             "--latency-msec=20", "--process-time-msec=10", "--device=" + device],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        try:
            with self.lock:
                self.device, self.status, self.error = device, "capturing", ""
            pending = b""
            while not self.stop_event.is_set():
                self._touch()
                readable, _, _ = select.select([process.stdout], [], [], .10)
                if readable:
                    data = os.read(process.stdout.fileno(), 4096)
                    if not data:
                        raise RuntimeError("PulseAudio monitor stream stopped")
                    pending += data
                    complete = len(pending) // 8 * 8
                    data = pending[:complete]
                    features = self._foreground_feed(foreground, 48000, 2, data)
                    frame = analyzer.feed(data)
                    if frame is not None:
                        self._publish({**frame, 'foreground': features})
                    pending = pending[complete:]
                elif process.poll() is not None:
                    raise RuntimeError("PulseAudio monitor process exited")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            process.stdout.close()

