"""Bounded 720p I420 pixels and PCM; explicit client frame credit."""
import asyncio
import math
import secrets
from collections import deque
import struct
import time

WIDTH, HEIGHT, FPS = 1280, 720, 60
FRAME_BYTES = WIDTH * HEIGHT * 3 // 2
MAX_FRAME_BYTES = FRAME_BYTES
HEADER = struct.Struct('<4sB3xIQ')
VIDEO, AUDIO = 1, 2
VIDEO_DELAY = 1.250  # Fallback only for a source with no audio.
FRAME_HISTORY = 128  # Fixed CPU history for A/V alignment; no extra GPU surfaces.
AUDIO_QUEUE = 192  # Bounded PCM burst allowance, matching the worker's packet cap.


def packet(kind, sequence, stamp, data):
    return HEADER.pack(b'FUV3', kind, sequence & 0xffffffff, stamp) + data


class MediaSession:
    def __init__(self):
        self.changed = asyncio.Event()
        self.credit = asyncio.Event(); self.credit.set()
        self.audio = asyncio.Queue(maxsize=AUDIO_QUEUE)
        self.inflight = None
        self.last_sent = -1
        self.closed = False
        self.id = secrets.token_urlsafe(18)
        self.audio_connected = False
        self.has_audio = False
        self.clock_sample = None
        self.clock_at = 0.
        self.clock_rate = 1.
        self.clock_playing = False

    def acknowledge(self, sequence):
        if type(sequence) is int and sequence == self.inflight:
            self.inflight = None; self.credit.set()

    def update_clock(self, value):
        if not isinstance(value, dict) or set(value) != {'sample', 'rate', 'playing'}: return False
        sample, rate = value['sample'], value['rate']
        if type(sample) not in (int, float) or not math.isfinite(sample) or not 0 <= sample < 2**53: return False
        if type(rate) not in (int, float) or not .99 <= rate <= 1.01 or type(value['playing']) is not bool: return False
        self.clock_sample, self.clock_rate, self.clock_playing = sample, rate, value['playing']
        self.clock_at = time.monotonic(); self.changed.set()
        return True

    def position(self):
        if self.clock_sample is None: return None
        # A stopped worklet never advances the picture beyond its last sound.
        elapsed = max(0., min(.150, time.monotonic()-self.clock_at)) if self.clock_playing else 0.
        return self.clock_sample + elapsed*48000*self.clock_rate

    def push_audio(self, data):
        self.has_audio = True
        if self.audio.full(): self.audio.get_nowait()
        self.audio.put_nowait(data)

    def close(self):
        self.closed = True; self.inflight = None
        self.changed.set(); self.credit.set()
        while not self.audio.empty(): self.audio.get_nowait()
        self.audio.put_nowait(None)


class FrameStore:
    def __init__(self):
        self.frames = deque(maxlen=FRAME_HISTORY)
        self.epoch = None

    def clear(self): self.frames.clear(); self.epoch = None

    def publish(self, sequence, data):
        now = time.monotonic()
        offset = now-sequence/FPS
        self.epoch = offset if self.epoch is None else min(self.epoch, offset)
        self.frames.append((now, sequence, data))

    def select(self, after, sample=None):
        deadline = time.monotonic()-VIDEO_DELAY
        for received, sequence, data in reversed(self.frames):
            # FFmpeg may write several independent frames in one pipe burst. Their
            # frame times, rather than identical arrival times, pace delivery.
            due = (sequence-1)*48000/FPS <= sample + .0001 if sample is not None else self.epoch+sequence/FPS <= deadline
            if due and sequence > after: return sequence, data
        return None


async def read_avi(reader, on_video, on_audio):
    """Read our fixed I420/PCM AVI pipe; no external AVI input parser."""
    header = await reader.readexactly(12)
    if header[:4] != b'RIFF' or header[8:] != b'AVI ': raise ValueError('Invalid decoder pipe header')
    video_sequence = audio_sequence = audio_samples = 0
    in_media = False
    while True:
        try: chunk = await reader.readexactly(8)
        except asyncio.IncompleteReadError as error:
            if error.partial: raise ValueError('Incomplete decoder pipe') from error
            return
        tag, length = chunk[:4], int.from_bytes(chunk[4:], 'little')
        if tag in (b'LIST', b'RIFF'):
            kind = await reader.readexactly(4)
            if kind in (b'movi', b'rec ', b'AVIX'): in_media = True; continue
            length -= 4
            if not 0 <= length <= 1024*1024: raise ValueError('Invalid decoder header size')
            await reader.readexactly(length + (length & 1)); continue
        if in_media and tag in (b'00dc', b'00db'):
            video_sequence += 1
            if length == 0: continue  # AVI may mark a duplicated slot with an empty chunk.
            if length != FRAME_BYTES: raise ValueError('Video frame exceeded its transport bound')
            data = await reader.readexactly(length)
            on_video(video_sequence, packet(VIDEO, video_sequence, video_sequence*1000000//FPS, data))
        elif in_media and tag == b'01wb':
            if length > 65536 or length % 4: raise ValueError('Invalid decoded audio packet')
            data = await reader.readexactly(length); audio_sequence += 1
            on_audio(packet(AUDIO, audio_sequence, audio_samples, data)); audio_samples += length//4
        else:
            if length > 1024*1024: raise ValueError('Decoder pipe chunk exceeded its bound')
            await reader.readexactly(length)
        if length & 1: await reader.readexactly(1)
