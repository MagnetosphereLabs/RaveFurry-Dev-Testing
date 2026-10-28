"""Local SRT reception with bounded independent 720p pictures and PCM audio."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import copy
import ctypes
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from urllib.parse import urlencode

from aiohttp import web, WSMsgType

from .srt_runtime import SRTRuntime, RuntimeSetupError, owns_udp_port
from .video_frames import FrameStore, MediaSession, read_avi, WIDTH, HEIGHT, FPS

HERE = Path(__file__).parent
MAX_QUEUE = 8  # Compatibility for diagnostics; media uses explicit frame credits.


def settings_path():
    root = Path(os.environ.get('LOCALAPPDATA', Path.home()/'AppData/Local')) if os.name == 'nt' else Path(os.environ.get('XDG_CONFIG_HOME', Path.home()/'.config'))
    return root/'Furatic'/'obs-video.json'


def defaults():
    event = dict(name='Event stream', bind='0.0.0.0', port=9000,
                 passphrase='67d6de062dbbe0c0fe8df5a6539b359b', senderIp='', latency=120)
    test = dict(event, name='Test stream', passphrase='FuraticLocalTest9000')
    return dict(version=1, layout='default', enabled=True, activeProfile='event',
                profiles={'event': event, 'test': test}, volume=.75, muted=False,
                locked=False, geometry={'x': .5, 'y': .5, 'width': 0})


def validate(value):
    if not isinstance(value, dict) or set(value) != set(defaults()):
        raise ValueError('Invalid settings fields')
    if value['version'] != 1 or value['layout'] not in ('default', 'video'):
        raise ValueError('Invalid layout')
    for key in ('enabled', 'muted', 'locked'):
        if type(value[key]) is not bool:
            raise ValueError('Invalid '+key)
    def number(n, lo, hi):
        return type(n) in (int, float) and math.isfinite(n) and lo <= n <= hi
    if not number(value['volume'], 0, 1):
        raise ValueError('Volume must be 0–100%')
    g = value['geometry']
    if not isinstance(g, dict) or set(g) != {'x', 'y', 'width'} or not all(number(g[k], 0, 1) for k in g):
        raise ValueError('Invalid video position')
    profiles = value['profiles']
    if not isinstance(profiles, dict) or not 1 <= len(profiles) <= 12 or value['activeProfile'] not in profiles:
        raise ValueError('Choose a saved receiver profile')
    for key, p in profiles.items():
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', key) or not isinstance(p, dict) or set(p) != {'name','bind','port','passphrase','senderIp','latency'}:
            raise ValueError('Invalid receiver profile')
        if not isinstance(p['name'], str) or not 1 <= len(p['name']) <= 60:
            raise ValueError('Profile name must be 1–60 characters')
        try:
            ipaddress.IPv4Address(p['bind'])
            if p['senderIp']:
                ipaddress.IPv4Address(p['senderIp'])
        except (ValueError, TypeError):
            raise ValueError('Use an IPv4 address; leave sender IP blank to allow any sender') from None
        if type(p['port']) is not int or not 1024 <= p['port'] <= 65535:
            raise ValueError('UDP port must be 1024–65535')
        if type(p['latency']) is not int or not 20 <= p['latency'] <= 8000:
            raise ValueError('SRT latency must be 20–8000 ms')
        if not isinstance(p['passphrase'], str) or not 10 <= len(p['passphrase'].encode('utf-8')) <= 79 or any(ord(c) < 32 for c in p['passphrase']):
            raise ValueError('SRT password must be 10–79 UTF-8 bytes')
    return copy.deepcopy(value)


class WindowsJob:
    """An OS-owned kill-on-close job prevents an FFmpeg orphan after a crash."""
    def __init__(self, pid):
        self.handle = None
        if os.name != 'nt':
            return
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('processTime', ctypes.c_int64), ('jobTime', ctypes.c_int64),
                        ('flags', w.DWORD), ('minimum', ctypes.c_size_t), ('maximum', ctypes.c_size_t),
                        ('active', w.DWORD), ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ('readOps','writeOps','otherOps','readBytes','writeBytes','otherBytes')]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('processMemory', ctypes.c_size_t),
                        ('jobMemory', ctypes.c_size_t), ('peakProcess', ctypes.c_size_t), ('peakJob', ctypes.c_size_t)]
        k = self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        for name, args, result in [('CreateJobObjectW',[ctypes.c_void_p,w.LPCWSTR],w.HANDLE),
                                  ('OpenProcess',[w.DWORD,w.BOOL,w.DWORD],w.HANDLE),
                                  ('CloseHandle',[w.HANDLE],w.BOOL),
                                  ('SetInformationJobObject',[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD],w.BOOL),
                                  ('AssignProcessToJobObject',[w.HANDLE,w.HANDLE],w.BOOL)]:
            fn = getattr(k, name); fn.argtypes = args; fn.restype = result
        self.handle = k.CreateJobObjectW(None, None)
        process = k.OpenProcess(0x0100 | 0x0001, False, pid)
        info = Extended(); info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            if not self.handle or not process or not k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not k.AssignProcessToJobObject(self.handle, process):
                raise OSError('Could not establish receiver process cleanup')
        except Exception:
            self.close(); raise
        finally:
            if process: k.CloseHandle(process)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle); self.handle = None


class VideoReceiver:
    def __init__(self, path=None):
        self.path = Path(path) if path else settings_path()
        self.config = defaults()
        self.load_error = ''
        try:
            if self.path.stat().st_size > 65536: raise ValueError('Settings file too large')
            self.config = validate(json.loads(self.path.read_text('utf-8')))
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError):
            self.load_error = 'Saved video settings could not be loaded; defaults are active. Save to repair.'
        # Rename only the original stock labels; retain team-assigned names/credentials.
        for key, old, new in [('event', 'Germany / Event', 'Event stream'), ('test', 'Local / VPN test', 'Test stream')]:
            if self.config['profiles'].get(key, {}).get('name') == old:
                self.config['profiles'][key]['name'] = new
        self.runtime = SRTRuntime(self.path.parent)
        self.listener_ready = False
        self.token = secrets.token_urlsafe(32)
        self.revision = 0
        self.status, self.detail = 'off', 'Default layout — receiver stopped'
        self.info = {}
        self.playback_error = ''
        self.generation = 0
        self.last_packet = 0
        self.suspended = False
        self.presentation_until = 0
        self.presentation_timer = None
        self.closed = False
        self.process = None
        self.task = None
        self.wake = asyncio.Event()
        self.media = set()
        self.frames = FrameStore()
        self.observers = set()
        self.signature = None
        self.firewall_task = None

    @property
    def active(self):
        return self.config['layout'] == 'video' and self.config['enabled'] and not self.suspended and not self.closed

    def profile(self):
        return self.config['profiles'][self.config['activeProfile']]

    def state(self, private=False):
        c = self.config
        result = {'revision': self.revision, 'layout': c['layout'], 'enabled': c['enabled'],
                  'volume': c['volume'], 'muted': c['muted'], 'locked': c['locked'],
                  'geometry': c['geometry'], 'status': self.status, 'detail': self.detail,
                  'listenerReady': self.listener_ready and self.active,
                  'runtimeReady': bool(self.runtime.executable),
                  'generation': self.generation, 'media': self.info, 'suspended': self.suspended,
                  'warning': self.load_error, 'playbackError': self.playback_error}
        if private: result.update(config=copy.deepcopy(c), token=self.token, windows=os.name == 'nt', receiverExecutable=self.runtime.executable or '')
        return result

    def changed(self):
        self.revision += 1
        value = self.state()
        for queue in tuple(self.observers):
            if queue.full(): queue.get_nowait()
            queue.put_nowait(value)

    def status_to(self, status, detail):
        if (status, detail) != (self.status, self.detail):
            self.status, self.detail = status, detail; self.changed()

    def save(self, value):
        value = validate(value)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent, prefix='.obs-video-', delete=False) as f:
                name = f.name; json.dump(value, f, ensure_ascii=False, indent=2); f.flush(); os.fsync(f.fileno())
            os.replace(name, self.path); name = None
        finally:
            if name:
                with contextlib.suppress(OSError): os.unlink(name)
        self.config = value; self.load_error = ''; self.changed(); self.reconcile()

    def reconcile(self, suspended=None):
        if suspended is not None: self.suspended = bool(suspended)
        signature = json.dumps({k:self.profile()[k] for k in ('bind','port','passphrase','latency')}, sort_keys=True) if self.active else None
        if signature != self.signature:
            self.signature = signature; self.wake.set()
        if not self.active:
            self.status_to('off', 'After-hours presentation — receiver stopped' if self.suspended else 'Receiver stopped')

    def presentation(self, until):
        until = float(until or 0)
        if until == self.presentation_until and self.presentation_timer: return
        self.presentation_until = until
        if self.presentation_timer: self.presentation_timer.cancel(); self.presentation_timer = None
        delay = until-time.time()
        self.reconcile(suspended=delay > 0)
        if delay > 0:
            try:
                def finish():
                    self.presentation_timer = None
                    self.presentation_until = 0
                    self.reconcile(suspended=False)
                    self.changed()
                self.presentation_timer = asyncio.get_running_loop().call_later(delay, finish)
            except RuntimeError: pass  # create_app may be called before its loop starts.

    def reset_media(self):
        self.generation += 1; self.info = {}; self.last_packet = 0; self.playback_error = ''
        self.frames.clear()
        for session in tuple(self.media): session.close()
        self.media.clear(); self.changed()

    def publish_video(self, sequence, data):
        self.last_packet = time.monotonic()
        self.frames.publish(sequence, data)
        if self.status != 'receiving': self.status_to('receiving', 'Receiving live video · bounded 720p / 60 FPS')
        for session in tuple(self.media): session.changed.set()

    def publish_audio(self, data):
        for session in tuple(self.media): session.push_audio(data)

    def command(self, executable):
        p = self.profile()
        query = urlencode({'mode':'listener','passphrase':p['passphrase'],'pbkeylen':32,
                           'enforced_encryption':1,'latency':p['latency']*1000,'timeout':5000000,'tlpktdrop':1})
        scale = ('scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2'
                 ':flags=fast_bilinear:out_color_matrix=bt709:out_range=tv,'
                 'pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60:start_time=0,format=yuv420p')
        return [executable, '-hide_banner', '-nostdin', '-loglevel', 'info',
                '-filter_threads', '1', '-analyzeduration', '1000000', '-probesize', '1048576',
                '-fflags', '+discardcorrupt', '-hwaccel', 'none', '-threads', '4',
                '-f', 'mpegts', '-i', f"srt://{p['bind']}:{p['port']}?{query}",
                '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale,
                '-c:v', 'libx264', '-threads:v', '2', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-profile:v', 'baseline', '-level:v', '3.2', '-pix_fmt', 'yuv420p',
                '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
                '-g', '1', '-bf', '0', '-refs', '1', '-crf', '18', '-maxrate', '12000k', '-bufsize', '12000k',
                '-x264-params', 'keyint=1:min-keyint=1:scenecut=0:repeat-headers=1:aud=1', '-vtag', 'H264',
                '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000',
                '-af', 'aresample=async=1:first_pts=0',
                '-f', 'avi', '-flush_packets', '1', 'pipe:1']

    async def start(self):
        self.task = asyncio.create_task(self.run()); self.presentation(self.presentation_until); self.reconcile()

    async def stop_process(self):
        p = self.process
        if p and p.returncode is None:
            with contextlib.suppress(ProcessLookupError): p.terminate()
            try: await asyncio.wait_for(p.wait(), 2)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError): p.kill()
                await p.wait()
        self.process = None

    async def close(self):
        self.closed = True; self.wake.set()
        if self.presentation_timer: self.presentation_timer.cancel(); self.presentation_timer = None
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError): await self.task
        await self.stop_process(); self.reset_media()
        if self.firewall_task:
            self.firewall_task.cancel()
            with contextlib.suppress(asyncio.CancelledError): await self.firewall_task

    async def run(self):
        retry = 1
        try:
            while not self.closed:
                self.wake.clear()
                if not self.active:
                    await self.wake.wait(); continue
                self.listener_ready = False
                self.status_to('preparing', 'Checking SRT receiver…')
                prepare = asyncio.create_task(self.runtime.resolve(lambda detail: self.status_to('preparing', detail)))
                changed = asyncio.create_task(self.wake.wait())
                try:
                    await asyncio.wait([prepare, changed], return_when=asyncio.FIRST_COMPLETED)
                    if changed.done(): continue
                    executable = prepare.result()
                except RuntimeSetupError as error:
                    self.status_to('setup_error', str(error))
                    await self.wake.wait(); continue
                except (OSError, ValueError):
                    self.status_to('setup_error', 'Receiver setup could not access its files. Check this PC’s write permissions, then retry setup.')
                    await self.wake.wait(); continue
                finally:
                    for task in (prepare, changed): task.cancel()
                    await asyncio.gather(prepare, changed, return_exceptions=True)
                if not self.active: continue
                self.reset_media(); self.status_to('starting', f"Opening UDP port {self.profile()['port']}…")
                job = None; tasks = []
                try:
                    self.process = await asyncio.create_subprocess_exec(*self.command(executable),
                        stdin=subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        limit=65536, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    job = WindowsJob(self.process.pid)
                    async def listening():
                        # A verified binary alone is insufficient: wait for this child's
                        # actual socket before telling the operator to start their sender.
                        for _ in range(200):
                            if self.process.returncode is not None: return
                            owned = owns_udp_port(self.process.pid, self.profile()['port'])
                            if owned is True or owned is None:
                                self.listener_ready = owned is True
                                if not self.last_packet:
                                    self.status_to('waiting', f"Ready to receive on UDP {self.profile()['port']}" if owned else 'Receiver running — waiting for sender')
                                else: self.changed()
                                await asyncio.Event().wait()
                            await asyncio.sleep(.05)
                        self.status_to('error', f"Could not open UDP {self.profile()['port']}. Release the old OBS SRT Media Source and retry.")
                    async def output():
                        await read_avi(self.process.stdout, self.publish_video, self.publish_audio)
                    async def stalled():
                        while True:
                            await asyncio.sleep(2)
                            if self.last_packet and time.monotonic()-self.last_packet > 10: return
                    async def errors():
                        while True:
                            line = await self.process.stderr.readline()
                            if not line: return
                            text = line.decode('utf-8', errors='replace')[:2048]
                            # Never expose the complete input URL in diagnostics.
                            if 'Video:' in text:
                                codec = re.search(r'Video:\s*([\w]+)', text)
                                size = re.search(r'\b(\d{2,5})x(\d{2,5})\b', text)
                                if codec and 'sourceWidth' not in self.info:
                                    self.info['videoCodec'] = codec.group(1)
                                    if size: self.info.update(sourceWidth=int(size.group(1)), sourceHeight=int(size.group(2)))
                                self.info.update(width=WIDTH, height=HEIGHT, fps=FPS, transport='bounded-h264-pcm16')
                                self.changed()
                            elif 'Audio:' in text:
                                codec = re.search(r'Audio:\s*([\w]+)', text)
                                if codec: self.info['audioCodec'] = codec.group(1); self.changed()
                            lower = text.lower()
                            if 'address already in use' in lower or 'bind' in lower and 'fail' in lower:
                                self.status_to('error', 'UDP port is busy. Release the old OBS SRT Media Source.')
                            elif 'protocol not found' in lower or 'unknown protocol' in lower:
                                self.status_to('error', 'SRT receiver support could not load. Retry receiver setup.')
                            elif 'password' in lower or 'passphrase' in lower or 'encryption' in lower and 'reject' in lower:
                                self.status_to('error', 'SRT encryption handshake failed. Check the selected profile password.')
                    tasks = [asyncio.create_task(output()), asyncio.create_task(errors()),
                             asyncio.create_task(self.process.wait()), asyncio.create_task(self.wake.wait()),
                             asyncio.create_task(listening()), asyncio.create_task(stalled())]
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for finished in done:
                        if not finished.cancelled() and finished.exception(): raise finished.exception()
                    if self.last_packet: retry = 1
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.status_to('error', 'The SRT receiver could not start or the stream stopped. Check FFmpeg, firewall, and sender settings.')
                finally:
                    self.listener_ready = False
                    await self.stop_process()
                    if len(tasks)>1:
                        with contextlib.suppress(asyncio.TimeoutError, Exception): await asyncio.wait_for(asyncio.shield(tasks[1]), .25)
                    for task in tasks: task.cancel()
                    if tasks: await asyncio.gather(*tasks, return_exceptions=True)
                    if job: job.close()
                    self.reset_media()
                if not self.active: continue
                if self.status != 'error': self.status_to('reconnecting', 'Waiting for the sender to reconnect')
                if self.wake.is_set(): continue
                try: await asyncio.wait_for(self.wake.wait(), retry)
                except asyncio.TimeoutError: pass
                retry = min(10, retry*2)
        finally:
            await self.stop_process()


def install_routes(app, receiver, port):
    """All routes inherit service.py's loopback Host/Origin guard."""
    sockets = set()

    def authorize(request):
        allowed = (f'http://127.0.0.1:{port}', f'http://localhost:{port}')
        if request.headers.get('Origin') not in allowed or not secrets.compare_digest(request.headers.get('X-Furatic-Video-Token', ''), receiver.token):
            raise web.HTTPForbidden(text='Open the local video controls page to make changes')

    async def static(request):
        names = {'controls':'video-controls.html', 'video-controls.js':'video-controls.js',
                 'obs-video.js':'obs-video.js', 'obs-video-renderer.js':'obs-video-renderer.js',
                 'obs-video-transport.js':'obs-video-transport.js', 'obs-video-audio.js':'obs-video-audio.js',
                 'mpegts.min.js':'vendor/mpegts.min.js'}
        name = names[request.match_info['file']]
        return web.FileResponse(HERE/name)

    async def state(request):
        return web.json_response(receiver.state(private=request.query.get('controls') == '1'))

    async def update(request):
        authorize(request)
        if request.content_length is None or request.content_length > 65536:
            raise web.HTTPRequestEntityTooLarge(max_size=65536, actual_size=request.content_length or 0)
        try:
            value = await request.json()
            # Settings page writes a complete document; drag/resize sends a
            # small patch so another operator's volume/profile isn't replaced.
            if isinstance(value, dict) and set(value) <= {'layout','enabled','volume','muted','locked','geometry','profiles','activeProfile'}:
                value = {**receiver.config, **value}
            receiver.save(value)
        except (ValueError, TypeError):
            raise web.HTTPBadRequest(text='Invalid settings. Check the receiver address, port, and password.') from None
        except OSError:
            raise web.HTTPServiceUnavailable(text='Settings could not be saved; the previous settings remain active.') from None
        return web.json_response(receiver.state(private=True))

    async def playback(request):
        authorize(request)
        if request.content_length is None or request.content_length > 512:
            raise web.HTTPBadRequest(text='Invalid playback report')
        try: value = await request.json()
        except ValueError: raise web.HTTPBadRequest(text='Invalid playback report') from None
        if not isinstance(value, dict) or set(value) != {'message','generation'} or type(value['generation']) is not int or not isinstance(value['message'], str) or len(value['message']) > 160:
            raise web.HTTPBadRequest(text='Invalid playback report')
        if receiver.active and receiver.generation == value['generation'] and receiver.playback_error != value['message']:
            receiver.playback_error = value['message']; receiver.changed()
        return web.json_response({'ok':True})

    async def events(request):
        if len(sockets) >= 8: raise web.HTTPServiceUnavailable(text='Control connection limit reached')
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1024, compress=False)
        sockets.add(ws); queue = asyncio.Queue(maxsize=1); receiver.observers.add(queue)
        sender = None
        try:
            await ws.prepare(request); await ws.send_json(receiver.state())
            async def send():
                try:
                    while not ws.closed:
                        value = await queue.get()
                        await asyncio.wait_for(ws.send_json(value), 1)
                except (ConnectionError, asyncio.TimeoutError, RuntimeError): pass
                finally: await ws.close()
            sender = asyncio.create_task(send())
            async for msg in ws:
                if msg.type in (WSMsgType.TEXT, WSMsgType.BINARY): break
        finally:
            if sender:
                sender.cancel(); await asyncio.gather(sender, return_exceptions=True)
            receiver.observers.discard(queue); sockets.discard(ws); await ws.close()
        return ws

    async def media(request):
        if not receiver.active: raise web.HTTPConflict(text='Select Video layout and enable the receiver')
        if receiver.media: raise web.HTTPServiceUnavailable(text='The live video is already playing in another display')
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=1024, compress=False)
        session = MediaSession(); receiver.media.add(session); sockets.add(ws)
        tasks = []
        try:
            await ws.prepare(request)
            async def pictures():
                try:
                    while not session.closed and not ws.closed:
                        await session.credit.wait()
                        if session.closed: break
                        session.changed.clear()
                        frame = receiver.frames.select(session.last_sent)
                        if frame is None:
                            try: await asyncio.wait_for(session.changed.wait(), .010)
                            except asyncio.TimeoutError: pass
                            continue
                        sequence, data = frame
                        session.inflight = sequence & 0xffffffff; session.last_sent = sequence; session.credit.clear()
                        await asyncio.wait_for(ws.send_bytes(data), 1)
                        data = frame = None  # Never retain an old frame while waiting for GPU credit.
                except (ConnectionError, asyncio.TimeoutError, RuntimeError): pass
                finally: await ws.close()
            async def audio():
                try:
                    while not session.closed and not ws.closed:
                        data = await session.audio.get()
                        if data is None: break
                        await asyncio.wait_for(ws.send_bytes(data), .5)
                except (ConnectionError, asyncio.TimeoutError, RuntimeError): pass
                finally: await ws.close()
            tasks = [asyncio.create_task(pictures()), asyncio.create_task(audio())]
            async for message in ws:
                if message.type != WSMsgType.TEXT: break
                try:
                    value = json.loads(message.data)
                    if not isinstance(value, dict) or set(value) != {'ack'}: break
                    session.acknowledge(value['ack'])
                except (ValueError, TypeError): break
        finally:
            session.close()
            for task in tasks: task.cancel()
            if tasks: await asyncio.gather(*tasks, return_exceptions=True)
            receiver.media.discard(session); sockets.discard(ws); await ws.close()
        return ws

    async def firewall(request):
        authorize(request)
        if os.name != 'nt': return web.json_response({'message':'On this computer, allow inbound UDP on the selected receiver port in its firewall.'})
        if receiver.firewall_task and not receiver.firewall_task.done():
            raise web.HTTPConflict(text='A firewall permission request is already open')
        executable = receiver.runtime.executable
        if not executable: raise web.HTTPConflict(text='Select Video layout and let receiver setup finish before allowing it in Windows Firewall.')
        p = receiver.profile()
        # JSON -> base64 -> fixed PowerShell code; no user text becomes shell code.
        payload = base64.b64encode(json.dumps({'program':str(Path(executable).resolve()),'port':p['port'],'remote':p['senderIp'] or 'Any'}).encode()).decode()
        elevated = "$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json; $ErrorActionPreference='Stop'; Get-NetFirewallRule -Name 'Furatic-SRT' -ErrorAction SilentlyContinue|Remove-NetFirewallRule; New-NetFirewallRule -Name 'Furatic-SRT' -DisplayName 'Furatic SRT receiver' -Direction Inbound -Action Allow -Protocol UDP -LocalPort $c.port -Program $c.program -RemoteAddress $c.remote -Profile Any|Out-Null"
        encoded = base64.b64encode(elevated.encode('utf-16-le')).decode()
        outer = "$ErrorActionPreference='Stop'; try { $p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand "+encoded+"'; exit $p.ExitCode } catch { exit 1 }"
        async def permit():
            proc = await asyncio.create_subprocess_exec('powershell.exe','-NoProfile','-NonInteractive','-Command',outer,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            try: return await proc.wait()
            finally:
                if proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError): proc.terminate()
        receiver.firewall_task = asyncio.create_task(permit())
        try: code = await asyncio.shield(receiver.firewall_task)
        except OSError: raise web.HTTPServiceUnavailable(text='Windows firewall permission request could not start') from None
        if code: raise web.HTTPBadRequest(text='Windows firewall permission was declined or failed. You can retry.')
        return web.json_response({'message':'UDP firewall permission saved for this profile. Reapply after changing its port or sender-IP restriction.'})

    async def retry(request):
        authorize(request)
        if not receiver.active: raise web.HTTPConflict(text='Select Video layout and enable the receiver first.')
        if receiver.status not in ('error', 'setup_error'):
            raise web.HTTPConflict(text='The receiver is already starting or running.')
        receiver.wake.set()
        return web.json_response({'message':'Retrying receiver…'})

    async def start(app): await receiver.start()
    async def stop(app):
        await receiver.close()
        for ws in tuple(sockets):
            with contextlib.suppress(Exception): await asyncio.wait_for(ws.close(code=1001), .5)

    app.router.add_get(r'/{file:controls|video-controls\.js|obs-video\.js|obs-video-renderer\.js|obs-video-transport\.js|obs-video-audio\.js|mpegts\.min\.js}', static)
    app.router.add_get('/video/state', state)
    app.router.add_post('/video/settings', update)
    app.router.add_post('/video/playback', playback)
    app.router.add_post('/video/firewall', firewall)
    app.router.add_post('/video/retry', retry)
    app.router.add_get('/video/events', events)
    app.router.add_get('/video/live', media)
    app.on_startup.append(start); app.on_shutdown.append(stop)
