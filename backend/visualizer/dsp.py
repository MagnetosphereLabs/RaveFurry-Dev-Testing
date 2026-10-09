"""Bounded stereo FFT analysis. No database, network, playback or file access."""
from __future__ import annotations

import math
import time
import numpy as np

BAND_COUNT = 48
FFT_SIZE = 2048


def empty_frame():
    return {
        "version": 1, "seq": 0, "level": 0.0, "bass": 0.0,
        "mid": 0.0, "treble": 0.0, "activity": 0.0,
        "bands": [0.0] * BAND_COUNT, "rms": [0.0, 0.0],
        "peak": [0.0, 0.0], "kickId": 0, "kick": 0.0,
        "kickAt": 0.0, "accentId": 0, "accent": 0.0,
        "accentAt": 0.0, "capturedAt": time.monotonic(),
    }


class Analyzer:
    """One fixed rolling window; stereo power cannot cancel in antiphase."""

    def __init__(self, rate=48000, channels=2):
        self.rate = int(rate)
        self.channels = int(channels)
        if not 8000 <= self.rate <= 192000 or not 1 <= self.channels <= 8:
            raise ValueError("Unsupported analysis format")
        self.samples = np.zeros((FFT_SIZE, self.channels), dtype=np.float32)
        self.window = np.hanning(FFT_SIZE).astype(np.float32)
        self.scale = 2.0 / float(self.window.sum())
        self.hop = max(128, round(self.rate / 60))
        self.pending = 0
        self.frequencies = np.fft.rfftfreq(FFT_SIZE, 1.0 / self.rate)
        edges = np.geomspace(30, min(18000, self.rate * .47), BAND_COUNT + 1)
        self.groups = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            indices = np.flatnonzero((self.frequencies >= lo) & (self.frequencies < hi))
            if not indices.size:
                indices = np.array([int(np.argmin(abs(self.frequencies - math.sqrt(lo * hi))))])
            self.groups.append(indices)
        self.regions = [
            (self.frequencies >= lo) & (self.frequencies < hi)
            for lo, hi in [(30, 220), (220, 3500), (3500, self.rate * .48)]
        ]
        self.previous = np.zeros(FFT_SIZE // 2 + 1)
        self.flux_average = np.zeros(2)
        self.smoothed_bands = np.zeros(BAND_COUNT)
        self.last = None
        self.activity = 0.0
        self.frame = empty_frame()

    @staticmethod
    def _level(amplitude, floor=-65.0, span=55.0):
        return np.clip((20 * np.log10(np.maximum(amplitude, 1e-9)) - floor) / span, 0, 1)

    def feed(self, data, timestamp=None):
        now = time.monotonic() if timestamp is None else float(timestamp)
        chunk = np.frombuffer(data, dtype="<f4")
        count = chunk.size // self.channels
        if count == 0:
            return None
        chunk = chunk[:count * self.channels].reshape(count, self.channels)
        # Reject corrupt/unsupported input without ever forwarding PCM.
        chunk = np.nan_to_num(chunk, nan=0.0, posinf=0.0, neginf=0.0)
        if count >= FFT_SIZE:
            self.samples[:] = chunk[-FFT_SIZE:]
        else:
            self.samples[:-count] = self.samples[count:]
            self.samples[-count:] = chunk
        self.pending += count
        if self.pending < self.hop:
            return None
        self.pending %= self.hop
        dt = min(.25, max(.001, now - self.last)) if self.last is not None else 1 / 60
        self.last = now

        transformed = np.fft.rfft(self.samples * self.window[:, None], axis=0)
        power = np.mean(np.abs(transformed * self.scale) ** 2, axis=1)
        amplitude = np.sqrt(power)
        rms = np.sqrt(np.mean(self.samples ** 2, axis=0))
        peak = np.max(np.abs(chunk), axis=0)
        overall = float(np.sqrt(np.mean(rms ** 2)))
        audible = overall > .00006  # approximately -84 dBFS
        raw_bands = np.array([np.sqrt(np.sum(power[g])) for g in self.groups])
        targets = self._level(raw_bands, -70, 60) if audible else np.zeros(BAND_COUNT)
        tau = np.where(targets > self.smoothed_bands, .018, .18)
        self.smoothed_bands += (targets - self.smoothed_bands) * (1 - np.exp(-dt / tau))
        region_values = [float(np.sqrt(np.sum(power[g]))) for g in self.regions]
        positive_flux = np.maximum(0, amplitude - self.previous)
        flux = np.array([
            float(np.sqrt(np.sum(positive_flux[self.regions[0]] ** 2))),
            float(np.sqrt(np.sum(positive_flux[self.regions[1] | self.regions[2]] ** 2))),
        ])
        floor = np.array([.0025, .0035])
        thresholds = np.maximum(floor, self.flux_average * 2.6)
        frame = dict(self.frame)
        # Independent onset counters retain events between transport frames.
        for i, (label, minimum_gap) in enumerate([("kick", .12), ("accent", .09)]):
            if audible and flux[i] > thresholds[i] and now - frame[label + "At"] > minimum_gap:
                strength = min(1.0, float(self._level(region_values[0 if i == 0 else 1], -60, 48)))
                if strength > .025:
                    frame[label + "Id"] += 1
                    frame[label] = round(strength, 4)
                    frame[label + "At"] = now
                    self.activity = min(1, self.activity + .16 * strength)
        self.flux_average += (flux - self.flux_average) * (1 - math.exp(-dt / .30))
        self.previous[:] = amplitude
        self.activity *= math.exp(-dt / 1.8)

        stereo_rms = (list(rms[:2]) if self.channels >= 2 else [rms[0], rms[0]])
        stereo_peak = (list(peak[:2]) if self.channels >= 2 else [peak[0], peak[0]])
        frame.update({
            "seq": frame["seq"] + 1, "capturedAt": now,
            "level": round(float(self._level(overall, -65, 55)) if audible else 0.0, 4),
            "bass": round(float(self._level(region_values[0], -65, 55)) if audible else 0.0, 4),
            "mid": round(float(self._level(region_values[1], -65, 55)) if audible else 0.0, 4),
            "treble": round(float(self._level(region_values[2], -70, 60)) if audible else 0.0, 4),
            "activity": round(self.activity, 4),
            "bands": np.round(self.smoothed_bands, 4).tolist(),
            "rms": [round(float(v), 6) for v in stereo_rms],
            "peak": [round(float(v), 6) for v in stereo_peak],
        })
        self.frame = frame
        return frame
