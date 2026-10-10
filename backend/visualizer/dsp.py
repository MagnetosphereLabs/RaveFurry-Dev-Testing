"""Bounded stereo FFT analysis. No database, network, playback or file access."""
from __future__ import annotations

import math
import time
import numpy as np

BAND_COUNT = 48
FFT_SIZE = 2048
# UI order: blue bass, purple presence, orange body, green treble.
# Green deliberately starts in the audible presence range, not ultrasound.
CLOUD_RANGES = ((30, 180), (650, 2400), (180, 650), (2400, 12000))


def empty_frame():
    return {
        "version": 1, "seq": 0, "level": 0.0, "bass": 0.0,
        "mid": 0.0, "treble": 0.0, "activity": 0.0,
        "bands": [0.0] * BAND_COUNT, "rms": [0.0, 0.0],
        "peak": [0.0, 0.0], "kickId": 0, "kick": 0.0,
        "kickAt": 0.0, "accentId": 0, "accent": 0.0,
        "accentAt": 0.0, "capturedAt": time.monotonic(),
        "cloudLevels": [0.0] * 4, "cloudBalance": [0.0] * 4,
        "cloudFlux": [0.0] * 4, "cloudIds": [0] * 4,
        "cloudAt": [0.0] * 4, "cloudStrength": [0.0] * 4,
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
        self.collected = 0
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
        # Soft crossovers keep a vocal harmonic near a boundary from abruptly
        # jumping between colors. The four weights partition spectral power.
        cloud_weights = []
        edge_width = math.log(1.12)
        for lo, hi in CLOUD_RANGES:
            lower = np.clip((np.log(np.maximum(self.frequencies, 1) / lo) + edge_width) / (2 * edge_width), 0, 1)
            upper = np.clip((np.log(np.maximum(self.frequencies, 1) / hi) + edge_width) / (2 * edge_width), 0, 1)
            cloud_weights.append(lower * lower * (3 - 2 * lower) * (1 - upper * upper * (3 - 2 * upper)))
        self.cloud_weights = np.array(cloud_weights)
        weight_sum = self.cloud_weights.sum(axis=0)
        self.cloud_weights /= np.maximum(1, weight_sum)
        self.flux_average = np.zeros(4)
        self.flux_deviation = np.zeros(4)
        self.previous_flux = np.zeros(4)
        self.cloud_reference = np.full(4, -65.0)
        self.cloud_levels = np.zeros(4)
        self.onset_armed = np.ones(4, dtype=bool)
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
        chunk = np.clip(np.nan_to_num(chunk, nan=0.0, posinf=0.0, neginf=0.0), -4, 4)
        if count >= FFT_SIZE:
            self.samples[:] = chunk[-FFT_SIZE:]
        else:
            self.samples[:-count] = self.samples[count:]
            self.samples[-count:] = chunk
        self.pending += count
        self.collected = min(FFT_SIZE, self.collected + count)
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
        cloud_power = self.cloud_weights @ power
        cloud_amplitude = np.sqrt(cloud_power)
        balance = cloud_power / max(1e-12, float(cloud_power.sum())) if audible else np.zeros(4)
        absolute = self._level(cloud_amplitude, -68, 58) if audible else np.zeros(4)
        db = 20 * np.log10(np.maximum(cloud_amplitude, 1e-9))
        # Local contrast brings out changes in mastered/compressed music, without
        # making silence or a constant tone generate invented rhythmic pulses.
        contrast = np.clip((db - self.cloud_reference) / 12, -1, 1)
        level = float(self._level(overall, -65, 55)) if audible else 0.0
        presence = np.sqrt(np.clip(balance / .015, 0, 1))
        targets_cloud = np.clip((absolute * (.72 + .13 * contrast) + .28 * level * np.sqrt(balance)) * presence, 0, 1)
        tau_cloud = np.where(targets_cloud > self.cloud_levels, .035, .24)
        self.cloud_levels += (targets_cloud - self.cloud_levels) * (1 - np.exp(-dt / tau_cloud))
        self.cloud_reference += (db - self.cloud_reference) * (1 - math.exp(-dt / 2.0))

        # Positive spectral changes are normalized against the signal in that
        # same bin. This detects quieter hits over a loud sustained mix. A
        # per-region energy gate and adaptive mean/deviation reject noise, slow
        # swells, and stationary spectra. No guessed BPM drives live lighting.
        relative_flux = np.maximum(0, amplitude - self.previous) / (amplitude + self.previous + .0005)
        flux = np.array([
            math.sqrt(float(np.sum(relative_flux ** 2 * power * weight)) / max(1e-12, cloud_power[i]))
            for i, weight in enumerate(self.cloud_weights)
        ])
        thresholds = np.maximum(.035, self.flux_average * 2.3 + self.flux_deviation * .8)
        # A finite FFT smears tones into neighboring bins. Require actual local
        # spectral peaks in a region, rather than lighting bass from the tail of
        # a vibrating vocal just above its boundary. Quiet real instruments and
        # broadband percussion still qualify even in a dense, louder mix.
        spectral_peaks = np.zeros_like(power, dtype=bool)
        spectral_peaks[1:-1] = (power[1:-1] >= power[:-2]) & (power[1:-1] > power[2:])
        onset_support = (self.cloud_weights @ (power * spectral_peaks)) / np.maximum(1e-12, cloud_power)
        frame = dict(self.frame)
        ids, onset_at, strengths = [list(frame[name]) for name in ("cloudIds", "cloudAt", "cloudStrength")]
        accents = []
        for i, minimum_gap in enumerate((.14, .16, .16, .12)):
            if flux[i] < thresholds[i] * .70:
                self.onset_armed[i] = True
            new_peak = flux[i] > self.previous_flux[i] * 1.5
            energy_gate = self.collected >= FFT_SIZE and audible and cloud_amplitude[i] > .0007 and balance[i] > .003 and onset_support[i] > .10
            if energy_gate and flux[i] > thresholds[i] and (self.onset_armed[i] or new_peak) and now - onset_at[i] > minimum_gap:
                novelty = min(1.0, float(flux[i] / max(.08, thresholds[i] * 2)))
                strength = min(1.0, float(absolute[i]) * (.45 + .55 * novelty) * float(presence[i]))
                ids[i] += 1
                onset_at[i], strengths[i] = now, round(strength, 4)
                self.onset_armed[i] = False
                self.activity = min(1, self.activity + .11 * strength)
                if i == 0:
                    frame.update(kickId=frame["kickId"] + 1, kick=round(strength, 4), kickAt=now)
                else:
                    accents.append(strength)
        # Retain the version-1 fields for older local HTML clients.
        if accents:
            frame.update(accentId=frame["accentId"] + 1, accent=round(max(accents), 4), accentAt=now)
        adaptation = 1 - math.exp(-dt / .50)
        self.flux_deviation += (np.abs(flux - self.flux_average) - self.flux_deviation) * adaptation
        self.flux_average += (flux - self.flux_average) * adaptation
        self.previous_flux[:] = flux
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
            "cloudLevels": np.round(self.cloud_levels, 4).tolist(),
            "cloudBalance": np.round(balance, 4).tolist(),
            "cloudFlux": np.round(np.clip(flux, 0, 1), 4).tolist(),
            "cloudIds": ids, "cloudAt": onset_at, "cloudStrength": strengths,
        })
        self.frame = frame
        return frame
