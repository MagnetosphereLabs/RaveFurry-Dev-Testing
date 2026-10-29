"""Bounded 720p I420 pixels and PCM; explicit client frame credit."""
import asyncio
import math
import secrets
from collections import deque
import struct
import threading
import time

WIDTH, HEIGHT, FPS = 1280, 720, 60
FRAME_BYTES = WIDTH * HEIGHT * 3 // 2
MAX_FRAME_BYTES = FRAME_BYTES
HEADER = struct.Struct('<4sB3xIQ')
VIDEO, AUDIO = 1, 2
VIDEO_DELAY = 1.250  # Fallback only for a source with no audio.
FRAME_HISTORY = 288  # 4.8 s: fixed RAM covers the 4 s PCM ring + device latency.
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
        self.last_resync = -float('inf')

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
        self.lock = threading.Lock()
        self.frames = deque(maxlen=FRAME_HISTORY)
        self.epoch = None

    def clear(self):
        with self.lock:
            self.frames.clear(); self.epoch = None

    def publish(self, sequence, data):
        now = time.monotonic()
        offset = now-sequence/FPS
        with self.lock:
            self.epoch = offset if self.epoch is None else min(self.epoch, offset)
            self.frames.append((now, sequence, data))

    def recovery_sample(self, sample):
        with self.lock:
            if sample is None or not self.frames: return None
            oldest = (self.frames[0][1]-1)*48000/FPS
            if sample < oldest-48000/FPS:
                return oldest + 28800  # Include output-device latency when rejoining.
            return None

    def select(self, after, sample=None):
        deadline = time.monotonic()-VIDEO_DELAY
        with self.lock:
            for received, sequence, data in reversed(self.frames):
                # FFmpeg may write several independent frames in one pipe burst.
                # Frame times, rather than arrival times, pace delivery.
                due = (sequence-1)*48000/FPS <= sample + .0001 if sample is not None else self.epoch+sequence/FPS <= deadline
                if due and sequence > after: return sequence, data
        return None


def _avi_chunks(on_video, on_audio):
    """Read our fixed I420/PCM AVI pipe; no external AVI input parser."""
    header = (yield 12)
    if header[:4] != b'RIFF' or header[8:] != b'AVI ': raise ValueError('Invalid decoder pipe header')
    video_sequence = audio_sequence = audio_samples = 0
    in_media = False
    while True:
        try: chunk = (yield 8)
        except asyncio.IncompleteReadError as error:
            if error.partial: raise ValueError('Incomplete decoder pipe') from error
            return
        tag, length = chunk[:4], int.from_bytes(chunk[4:], 'little')
        if tag in (b'LIST', b'RIFF'):
            kind = (yield 4)
            if kind in (b'movi', b'rec ', b'AVIX'): in_media = True; continue
            length -= 4
            if not 0 <= length <= 1024*1024: raise ValueError('Invalid decoder header size')
            (yield length + (length & 1)); continue
        if in_media and tag in (b'00dc', b'00db'):
            video_sequence += 1
            if length == 0: continue  # AVI may mark a duplicated slot with an empty chunk.
            if length != FRAME_BYTES: raise ValueError('Video frame exceeded its transport bound')
            data = (yield length)
            on_video(video_sequence, packet(VIDEO, video_sequence, video_sequence*1000000//FPS, data))
        elif in_media and tag == b'01wb':
            if length > 65536 or length % 4: raise ValueError('Invalid decoded audio packet')
            data = (yield length); audio_sequence += 1
            on_audio(packet(AUDIO, audio_sequence, audio_samples, data)); audio_samples += length//4
        else:
            if length > 1024*1024: raise ValueError('Decoder pipe chunk exceeded its bound')
            (yield length)
        if length & 1: (yield 1)


async def read_avi(reader, on_video, on_audio):
    """Async adapter retained for callers/tests; the live receiver uses the worker."""
    parser = _avi_chunks(on_video, on_audio)
    try:
        length = next(parser)
        while True:
            try: data = await reader.readexactly(length)
            except asyncio.IncompleteReadError as error: length = parser.throw(error)
            else: length = parser.send(data)
            await asyncio.sleep(0)
    except StopIteration:
        pass
    finally:
        parser.close()


def read_avi_blocking(stream, on_video, on_audio):
    """Read whole bounded chunks on a dedicated pipe thread, outside asyncio."""
    parser = _avi_chunks(on_video, on_audio)
    try:
        length = next(parser)
        while True:
            data = stream.read(length)
            if len(data) != length:
                length = parser.throw(asyncio.IncompleteReadError(data, length))
            else:
                length = parser.send(data)
    except StopIteration:
        pass
    finally:
        parser.close()


class DecoderPipe:
    """Drain FFmpeg independently of the service loop and music metadata work.

    Video goes straight into the existing fixed frame history. Only one wakeup
    and at most four seconds of PCM can wait for asyncio; no raw-frame callback
    queue and no second video history are created.
    """
    def __init__(self, stream, frames, video_ready, audio_ready):
        self.stream, self.frames = stream, frames
        self.video_ready, self.audio_ready = video_ready, audio_ready
        self.loop = asyncio.get_running_loop()
        self.done = self.loop.create_future()
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.audio = deque()
        self.audio_bytes = 0
        self.video_pending = self.scheduled = self.ended = False
        self.error = None
        self.thread = threading.Thread(target=self._read, name='obs-video-pipe', daemon=True)

    def _schedule(self):
        # Called under the short bridge lock. Never schedule one callback per
        # frame/pipe fragment while the loop is busy doing music/HTTP work.
        if not self.scheduled:
            self.scheduled = True
            self.loop.call_soon_threadsafe(self._drain)

    def _video(self, sequence, data):
        if self.stopping.is_set(): return
        self.frames.publish(sequence, data)
        with self.lock:
            self.video_pending = True
            self._schedule()

    def _audio(self, data):
        if self.stopping.is_set(): return
        with self.lock:
            self.audio.append(data); self.audio_bytes += len(data)-HEADER.size
            while self.audio_bytes > 48000*4*4 or len(self.audio) > AUDIO_QUEUE:
                self.audio_bytes -= len(self.audio.popleft())-HEADER.size
            self._schedule()

    def _read(self):
        error = None
        try:
            read_avi_blocking(self.stream, self._video, self._audio)
        except Exception as caught:
            if not self.stopping.is_set(): error = caught
        finally:
            self.stream.close()
            with self.lock:
                self.error, self.ended = error, True
                self._schedule()

    def _drain(self):
        with self.lock:
            audio, self.audio = self.audio, deque()
            video, self.video_pending = self.video_pending, False
            ended, error = self.ended, self.error
            self.error = None
            self.audio_bytes = 0
            self.scheduled = False
        if not self.stopping.is_set() and not self.done.done():
            try:
                if video: self.video_ready()
                for data in audio: self.audio_ready(data)
            except Exception as caught:
                error, ended = caught, True
                self.stopping.set()
        if ended and not self.done.done():
            if error: self.done.set_exception(error)
            else: self.done.set_result(None)

    async def run(self):
        self.thread.start()
        await self.done

    def request_stop(self):
        self.stopping.set()

    async def close(self):
        # The owner terminates/reaps FFmpeg first: its pipe then reaches EOF,
        # so a blocked read cannot outlive a mode switch or receiver shutdown.
        self.request_stop()
        if self.thread.ident is not None:
            await asyncio.to_thread(self.thread.join, 2)
            if self.thread.is_alive(): raise RuntimeError('Decoder pipe did not close')
        else:
            self.stream.close()
        with self.lock:
            self.audio.clear(); self.audio_bytes = 0; self.error = None
        if not self.done.done(): self.done.cancel()
        elif not self.done.cancelled(): self.done.exception()
