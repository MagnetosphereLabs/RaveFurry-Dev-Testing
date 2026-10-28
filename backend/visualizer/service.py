"""Loopback-only OBS page and metadata socket. Never imports Django or libpq."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import logging
import json
import math
import hmac
import re
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import time

# Numerical work stays in one worker rather than spawning BLAS thread pools.
for name in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS"):
    os.environ[name] = "1"

from aiohttp import web, WSMsgType
from .capture import Capture

MAX_CLIENTS = 4
PAGE = Path(__file__).with_name("obs-background.html")
NOTIFICATION_SCRIPT = Path(__file__).with_name("obs-topbar.js")

LOG = logging.getLogger("furatic.visualizer")


def local_request(request, port):
    """Reject foreign Hosts/Origins, including accidental reverse-proxy exposure."""
    if request.remote not in ("127.0.0.1", "::1"):
        return False
    if request.host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
        return False
    origin = request.headers.get("Origin")
    return origin in (None, "null", f"http://127.0.0.1:{port}", f"http://localhost:{port}")


class ParentGuard:
    def __init__(self, pid):
        self.pid = pid
        self.handle = None
        if pid and os.name == "nt":
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            self.kernel.OpenProcess.restype = ctypes.c_void_p
            self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            self.kernel.WaitForSingleObject.restype = ctypes.c_ulong
            self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            self.kernel.CloseHandle.restype = ctypes.c_int
            # One process handle for this service's entire lifetime.
            self.handle = self.kernel.OpenProcess(0x00100000, False, pid)

    def alive(self):
        if not self.pid:
            return True
        if os.name == "nt":
            return bool(self.handle) and self.kernel.WaitForSingleObject(self.handle, 0) == 0x102
        return os.getppid() == self.pid

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def create_app(capture, port):
    clients = set()
    overlay = {"version": 1, "updatedAt": 0, "mode": "event", "song": None, "queueEmpty": False, "message": None}
    cover_id, cover_bytes, cover_type = '', b'', 'image/jpeg'
    publish_token = os.environ.get('FURATIC_OBS_PUBLISH_TOKEN', '')
    publishers = set()
    scene = None
    scene_at = 0.0
    scene_sequence = 0
    scene_lengths = {"motion": 4, "clouds": 16, "material": 16, "dance": 4,
                     "thumps": 4, "bass": 2, "music": 4, "energy": 4, "sizes": 4,
                     "bands": 48, "lights": 4, "edgeEnergy": 4, "edgeLights": 4,
                     "edgeMusic": 4, "edgeBands": 48}

    def snapshot():
        frame = capture.snapshot()
        if scene is not None and time.monotonic() - scene_at < .35:
            frame["scene"] = {"sequence": scene_sequence, "uniforms": scene}
        return frame
    @web.middleware
    async def only_local(request, handler):
        if not local_request(request, port):
            raise web.HTTPForbidden(text="Local OBS access only")
        response = await handler(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", f"http://127.0.0.1:{port}")
        return response

    async def page(request):
        return web.Response(body=PAGE.read_bytes(), content_type="text/html")

    async def notification_script(request):
        return web.Response(body=NOTIFICATION_SCRIPT.read_bytes(), content_type="application/javascript")

    def authorize(request):
        if not publish_token or not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + publish_token):
            raise web.HTTPForbidden(text='Private publisher only')

    async def overlay_state(request):
        return web.json_response(overlay)

    async def publish_overlay(request):
        nonlocal overlay
        authorize(request)
        if request.content_length is None or request.content_length > 32768:
            raise web.HTTPRequestEntityTooLarge(max_size=32768, actual_size=request.content_length or 0)
        try:
            value = await request.json()
            if not isinstance(value, dict) or value.get('version') != 1 or value.get('mode') not in {'event', 'closing', 'afterhours'}:
                raise ValueError()
            at = value.get('updatedAt')
            if type(at) not in (int, float) or not math.isfinite(at) or abs(time.time() - at) > 30:
                raise ValueError()
            if type(value.get('queueEmpty')) is not bool:
                raise ValueError()
            song = value.get('song')
            if song is not None:
                if not isinstance(song, dict) or type(song.get('paused')) is not bool:
                    raise ValueError()
                for key, maximum in [('id', 64), ('title', 1000), ('artist', 1000), ('artwork', 64)]:
                    if not isinstance(song.get(key), str) or len(song[key]) > maximum:
                        raise ValueError()
                if song['artwork'] and not re.fullmatch(r'/overlay-artwork/[A-Za-z0-9_-]{11}', song['artwork']):
                    raise ValueError()
                for key in ('position', 'duration', 'votes'):
                    number = song.get(key)
                    if type(number) not in (int, float) or not math.isfinite(number) or abs(number) > 10000000:
                        raise ValueError()
                if song['position'] < 0 or song['duration'] < 0:
                    raise ValueError()
                song = {key: song[key] for key in ('id', 'title', 'artist', 'artwork', 'paused', 'position', 'duration', 'votes')}
            message = value.get('message')
            if message is not None:
                if not isinstance(message, dict) or message.get('kind') not in {'rank', 'risk', 'reminder'} or not isinstance(message.get('id'), str) or len(message['id']) > 64:
                    raise ValueError()
                for key in ('headline', 'title', 'artist', 'detail', 'footer'):
                    if not isinstance(message.get(key), str) or len(message[key]) > (1000 if key in {'title', 'artist'} else 240):
                        raise ValueError()
                for key in ('createdAt', 'expiresAt'):
                    if type(message.get(key)) not in (int, float) or not math.isfinite(message[key]):
                        raise ValueError()
                if message.get('kind') == 'rank' and message.get('rank') not in (1, 2, 3):
                    raise ValueError()
            if value['updatedAt'] >= overlay['updatedAt']:
                overlay = {'version': 1, 'updatedAt': at, 'mode': value['mode'], 'song': song,
                           'queueEmpty': value['queueEmpty'], 'message': message}
        except (ValueError, TypeError, KeyError):
            raise web.HTTPBadRequest(text='Invalid overlay snapshot') from None
        return web.json_response({'ok': True, 'artworkId': cover_id})

    async def publish_artwork(request):
        nonlocal cover_id, cover_bytes, cover_type
        authorize(request)
        video = request.match_info['video']
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
            raise web.HTTPBadRequest()
        data = await request.read()
        if not data or len(data) > 2 * 1024 * 1024:
            raise web.HTTPBadRequest()
        if data.startswith(b'\xff\xd8\xff'):
            mime = 'image/jpeg'
        elif data.startswith(b'\x89PNG\r\n\x1a\n'):
            mime = 'image/png'
        elif data.startswith(b'RIFF') and data[8:12] == b'WEBP':
            mime = 'image/webp'
        else:
            raise web.HTTPBadRequest()
        cover_id, cover_bytes, cover_type = video, data, mime
        return web.json_response({'ok': True})

    async def artwork(request):
        if request.match_info['video'] != cover_id or not cover_bytes:
            raise web.HTTPNotFound()
        return web.Response(body=cover_bytes, content_type=cover_type)

    async def health(request):
        alive = capture.healthy()
        return web.json_response({"service": "furatic-visualizer", "version": 1,
                                  "workerAlive": alive, "status": capture.snapshot()["status"]}, status=200 if alive else 503)

    async def features(request):
        return web.json_response(snapshot())

    async def publish_scene(request):
        nonlocal scene, scene_at, scene_sequence
        if publishers:
            raise web.HTTPServiceUnavailable(text="OBS scene publisher already connected")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=16384, compress=False)
        publishers.add(ws)
        try:
            await ws.prepare(request)
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    values = json.loads(message.data)
                    if not isinstance(values, dict) or set(values) != set(scene_lengths):
                        raise ValueError("Invalid scene fields")
                    for key, length in scene_lengths.items():
                        vector = values[key]
                        if not isinstance(vector, list) or len(vector) != length:
                            raise ValueError("Invalid scene vector")
                        if any(type(value) not in (int, float) or not math.isfinite(value)
                               or abs(value) > 10000 for value in vector):
                            raise ValueError("Invalid scene value")
                    scene = values
                    scene_at = time.monotonic()
                    scene_sequence += 1
                except (ValueError, TypeError):
                    await ws.close(code=1008, message=b"Invalid scene metadata")
                    break
        finally:
            publishers.discard(ws)
            scene = None
            if not ws.closed:
                await ws.close()
        return ws

    async def socket(request):
        if len(clients) >= MAX_CLIENTS:
            raise web.HTTPServiceUnavailable(text="Visualizer client limit reached")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1024, compress=False)
        # Reserve before the handshake's first await to enforce the client cap.
        clients.add(ws)
        sender = None
        try:
            await ws.prepare(request)
            async def send():
                try:
                    while not ws.closed:
                        frame = snapshot()
                        # A blocked OBS client is dropped, never given a growing queue.
                        await asyncio.wait_for(ws.send_json(frame), timeout=.50)
                        await asyncio.sleep(.020)
                except (ConnectionError, asyncio.TimeoutError, RuntimeError):
                    await ws.close()
            sender = asyncio.create_task(send())
            async for message in ws:
                # This is a read-only stream; commands and PCM are not accepted.
                if message.type in (WSMsgType.TEXT, WSMsgType.BINARY):
                    await ws.close(code=1008, message=b"Read-only metadata")
                    break
        finally:
            if sender:
                sender.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sender
            clients.discard(ws)
            if not ws.closed:
                await ws.close()
        return ws

    async def close_sockets(app):
        for ws in tuple(clients | publishers):
            with contextlib.suppress(asyncio.TimeoutError, ConnectionError):
                await asyncio.wait_for(ws.close(code=1001, message=b"Visualizer stopping"), timeout=.50)

    app = web.Application(middlewares=[only_local], client_max_size=2 * 1024 * 1024 + 1)
    app.router.add_get("/", page)
    app.router.add_get("/obs-background.html", page)
    app.router.add_get("/obs-topbar.js", notification_script)
    app.router.add_get("/overlay-state", overlay_state)
    app.router.add_post("/overlay-state", publish_overlay)
    app.router.add_get("/overlay-artwork/{video}", artwork)
    app.router.add_post("/overlay-artwork/{video}", publish_artwork)
    app.router.add_get("/_healthz/", health)
    app.router.add_get("/features", socket)
    app.router.add_get("/features.json", features)
    app.router.add_get("/scene", publish_scene)
    app.on_shutdown.append(close_sockets)
    return app


async def run(port, parent_pid):
    capture = Capture()
    guard = ParentGuard(parent_pid)
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    stop_signals = [signal.SIGINT, signal.SIGTERM]
    if os.name == "nt":
        stop_signals.append(signal.SIGBREAK)
    for signum in stop_signals:
        try:
            loop.add_signal_handler(signum, stopping.set)
        except NotImplementedError:
            signal.signal(signum, lambda *args: loop.call_soon_threadsafe(stopping.set))
    runner = web.AppRunner(create_app(capture, port), access_log=None, shutdown_timeout=2)
    try:
        if not guard.alive():
            return
        await runner.setup()
        # This host is intentionally not configurable to 0.0.0.0.
        await web.TCPSite(runner, host="127.0.0.1", port=port).start()
        capture.start()
        while guard.alive() and not stopping.is_set():
            try:
                await asyncio.wait_for(stopping.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass
    finally:
        try:
            await runner.cleanup()
        finally:
            try:
                if capture.thread.ident is not None:
                    capture.close()
            finally:
                guard.close()


def main():
    parser = argparse.ArgumentParser(description="Local OBS audio-reactive visualizer")
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--port", type=int, default=int(os.environ.get("FURATIC_VISUALIZER_PORT", "8766")))
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use a local port from 1024 through 65535")
    log_dir = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "state"))) / "Raveberry"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(log_dir / "visualizer.log", maxBytes=512000, backupCount=2)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger().addHandler(handler)
        logging.getLogger().setLevel(logging.WARNING)
    except OSError:
        logging.basicConfig(level=logging.WARNING)
    try:
        asyncio.run(run(args.port, args.parent_pid))
    except KeyboardInterrupt:
        pass
    except OSError as error:
        LOG.error("Could not bind local visualizer port: %s", error)
        raise SystemExit(73)


if __name__ == "__main__":
    main()
