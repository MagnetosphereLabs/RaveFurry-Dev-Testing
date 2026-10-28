"""Fixed-storage foreground analysis matching the broadcast's OBS settings.

The cloud analyzer is deliberately independent. This consumes the same passive
capture packets and publishes only 26 bar values, one color and a logo scale.
"""
from __future__ import annotations

import math
import time
import numpy as np


class ForegroundAnalyzer:
    FFT_SIZE = 4096
    BAR_COUNT = 26

    def __init__(self, rate=48000, channels=2):
        self.rate, self.channels = int(rate), int(channels)
        self.samples = np.zeros((self.FFT_SIZE, self.channels), dtype=np.float32)
        self.window = np.hanning(self.FFT_SIZE).astype(np.float32)
        self.magnitudes = np.zeros((self.FFT_SIZE // 2 + 1, self.channels))
        self.rms_window = np.zeros(self.rate, dtype=np.float32)
        self.rms_position = 0
        self.rms_sum = 0.0
        self.logo_samples = np.zeros(1024, dtype=np.float32)
        self.logo_position = 0
        self.logo_db = -35.0
        self.pending = self.collected = 0
        self.last = None
        edges = np.geomspace(max(1.0, 30*self.FFT_SIZE/self.rate),
                             min(self.FFT_SIZE/2-1, 16000*self.FFT_SIZE/self.rate), self.BAR_COUNT+1)
        self.groups = []
        for left, right in zip(edges[:-1], edges[1:]):
            positions = left + np.arange(max(1, int(right-left)))
            base = positions.astype(int)
            t = positions-base
            weights = np.array([-.5*t+t*t-.5*t**3, 1-2.5*t*t+1.5*t**3,
                                .5*t+2*t*t-1.5*t**3, -.5*t*t+.5*t**3]).T
            indices = np.clip(base[:, None]+np.arange(-1, 3), 0, self.FFT_SIZE//2)
            self.groups.append((indices, weights))
        self.frame = self.empty()

    @staticmethod
    def empty():
        return {'bands': [0.0]*26, 'color': [1.0, 1.0, 1.0, 0.0], 'logoScale': .7}

    def feed(self, data, timestamp=None):
        now = time.monotonic() if timestamp is None else float(timestamp)
        chunk = np.frombuffer(data, dtype='<f4')
        count = chunk.size//self.channels
        if not count or not math.isfinite(now):
            return self.frame
        chunk = np.clip(np.nan_to_num(chunk[:count*self.channels].reshape(count, self.channels)), -4, 4)
        # One second of RMS squares, overwriting the oldest values in-place.
        squares = np.mean(chunk[:, :2]**2, axis=1)
        for offset in range(0, count, self.rate):
            part = squares[offset:offset+self.rate]
            length = len(part)
            first = min(length, self.rate-self.rms_position)
            for start, values in [(self.rms_position, part[:first]), (0, part[first:])]:
                if len(values):
                    self.rms_sum += float(np.sum(values, dtype=np.float64)-np.sum(self.rms_window[start:start+len(values)], dtype=np.float64))
                    self.rms_window[start:start+len(values)] = values
            self.rms_position = (self.rms_position+length) % self.rate
        # Scale To Sound uses RMS and a dB slew, not the spectrum's EMA.
        position = 0
        while position < count:
            length = min(count-position, 1024-self.logo_position)
            self.logo_samples[self.logo_position:self.logo_position+length] = chunk[position:position+length, 0]
            self.logo_position += length
            position += length
            if self.logo_position == 1024:
                db = 20*math.log10(max(1e-9, math.sqrt(float(np.mean(self.logo_samples**2)))))
                self.logo_db = max(-35.0, self.logo_db)
                self.logo_db += .65 if self.logo_db < db else -.65 if self.logo_db > db else 0
                self.logo_position = 0
        if count >= self.FFT_SIZE:
            self.samples[:] = chunk[-self.FFT_SIZE:]
        else:
            self.samples[:-count] = self.samples[count:]
            self.samples[-count:] = chunk
        self.collected = min(self.FFT_SIZE, self.collected+count)
        self.pending += count
        hop = max(128, round(self.rate/60))
        if self.pending < hop or self.collected < self.FFT_SIZE:
            return self.frame
        self.pending %= hop
        dt = 1/60 if self.last is None else max(0.0, min(.25, now-self.last))
        if self.last is not None and (now-self.last > .3 or now < self.last):
            self.magnitudes.fill(0)
        self.last = now
        magnitude = np.abs(np.fft.rfft(self.samples*self.window[:, None], axis=0))*(2/float(self.window.sum()))
        gravity = .65**(dt*60)
        self.magnitudes *= gravity
        self.magnitudes += (1-gravity)*magnitude
        mono = np.mean(self.magnitudes[:, :2], axis=1)
        decibels = 20*np.log10(np.maximum(mono, 1e-9))
        rms = math.sqrt(max(0.0, self.rms_sum/self.rate))
        decibels += min(30.0, -8-20*math.log10(max(1e-9, rms)))
        values = [float(np.clip((np.mean(np.sum(decibels[indices]*weights, axis=1))+65)/65, 0, 1))
                  for indices, weights in self.groups]
        pulse = min(1.0, max(values)/1.25)
        self.frame = {'bands': [round(value, 5) for value in values],
                      'color': [round(1-pulse, 5), round(1+(142/255-1)*pulse, 5), round(1+(248/255-1)*pulse, 5), round(pulse, 5)],
                      'logoScale': round(float(np.clip(.7+(35+self.logo_db)/35*.3, .7, 1)), 5)}
        return self.frame
