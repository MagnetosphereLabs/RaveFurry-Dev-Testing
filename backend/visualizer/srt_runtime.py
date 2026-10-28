"""Private SRT executable selection/setup; never changes the application's FFmpeg."""
from __future__ import annotations

import asyncio
import contextlib
import ctypes
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import zipfile

from aiohttp import ClientSession, ClientTimeout

# Pinned release and publisher's SHA-256, verified against gyan.dev on 2026-10-28.
# Gyan's static essentials build includes libsrt; FFmpeg.org links to this builder.
ARCHIVE_URL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
ARCHIVE_SHA256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXECUTABLE = 256 * 1024 * 1024
WINDOWS = sys.platform == 'win32'


class RuntimeSetupError(Exception):
    pass


async def reap(process):
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError): process.terminate()
        try: await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError): process.kill()
            await process.wait()


async def supports_srt(executable):
    """Probe the actual input protocol, not a filename, version, or build flag."""
    process = None
    try:
        process = await asyncio.create_subprocess_exec(str(executable), '-hide_banner', '-protocols',
            stdin=subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
        output, _ = await asyncio.wait_for(process.communicate(), 8)
        inputs = output.decode('utf-8', errors='replace').split('Input:', 1)[-1].split('Output:', 1)[0]
        return process.returncode == 0 and 'srt' in inputs.split()
    except (OSError, asyncio.TimeoutError):
        return False
    finally:
        if process: await reap(process)


class SRTRuntime:
    def __init__(self, folder):
        self.folder = Path(folder) / 'srt-runtime'
        self.executable = None
        self.checked = {}
        self.lock = asyncio.Lock()

    def candidates(self):
        candidates = [self.folder/'ffmpeg.exe', shutil.which('ffmpeg'),
                      Path(sys.prefix)/'Library/bin/ffmpeg.exe', Path(sys.executable).parent/'ffmpeg.exe']
        seen = set()
        for candidate in candidates:
            if not candidate: continue
            path = Path(candidate)
            if not path.is_file(): continue
            key = str(path.resolve())
            if key not in seen:
                seen.add(key); yield key

    async def check(self, path):
        try:
            stat = Path(path).stat()
            signature = (stat.st_mtime_ns, stat.st_size)
        except OSError: return False
        previous = self.checked.get(path)
        if previous and previous[0] == signature: return previous[1]
        supported = await supports_srt(path)
        self.checked[path] = (signature, supported)
        return supported

    async def resolve(self, progress):
        async with self.lock:
            for path in self.candidates():
                if await self.check(path):
                    self.executable = path
                    return path
            if not WINDOWS:
                raise RuntimeSetupError('No SRT-capable FFmpeg was found. Install FFmpeg with the srt input protocol, then retry.')
            progress('Preparing receiver — downloading SRT support…')
            return await self.download(progress)

    async def download(self, progress):
        self.folder.mkdir(parents=True, exist_ok=True)
        # Everything is staged on the same volume and removed on cancellation/error.
        with tempfile.TemporaryDirectory(prefix='setup-', dir=self.folder) as temporary:
            stage = Path(temporary); archive = stage/'ffmpeg.zip'
            digest = hashlib.sha256(); received = 0; last_percent = -1
            timeout = ClientTimeout(total=600, sock_connect=20, sock_read=30)
            try:
                async with ClientSession(timeout=timeout, trust_env=True) as session:
                    async with session.get(ARCHIVE_URL) as response:
                        response.raise_for_status()
                        total = response.content_length or 0
                        if total > MAX_ARCHIVE: raise RuntimeSetupError('Receiver download exceeds its size limit.')
                        with archive.open('wb') as output:
                            async for data in response.content.iter_chunked(65536):
                                received += len(data)
                                if received > MAX_ARCHIVE: raise RuntimeSetupError('Receiver download exceeds its size limit.')
                                output.write(data); digest.update(data)
                                percent = min(99, int(received*100/total)) if total else 0
                                if percent != last_percent:
                                    last_percent = percent
                                    progress(f'Preparing receiver — downloading SRT support {percent}%' if total else 'Preparing receiver — downloading SRT support…')
                if digest.hexdigest() != ARCHIVE_SHA256:
                    raise RuntimeSetupError('Receiver download failed its integrity check. Retry setup.')
                progress('Preparing receiver — verifying SRT support…')
                await self.unpack(archive, stage)
                executable = stage/'ffmpeg.exe'
                if not await supports_srt(executable):
                    raise RuntimeSetupError('The downloaded receiver could not run with SRT support on this PC.')
                # Publish only a fully extracted and tested executable. Preserve notices.
                for name in ('LICENSE', 'README.txt'):
                    if (stage/name).exists(): os.replace(stage/name, self.folder/name)
                destination = self.folder/'ffmpeg.exe'
                os.replace(executable, destination)
                self.executable = str(destination.resolve())
                return self.executable
            except asyncio.CancelledError: raise
            except RuntimeSetupError: raise
            except Exception as error:
                raise RuntimeSetupError('Receiver setup could not finish. Check this PC’s internet connection and write permissions, then retry setup.') from error

    async def unpack(self, archive, stage):
        # No extractall/path traversal; read only fixed known payload names.
        with zipfile.ZipFile(archive) as package:
            entries = [item for item in package.infolist() if item.filename.endswith('/bin/ffmpeg.exe')]
            if len(entries) != 1 or not 0 < entries[0].file_size <= MAX_EXECUTABLE:
                raise RuntimeSetupError('Receiver package is missing a valid executable.')
            with package.open(entries[0]) as source, (stage/'ffmpeg.exe').open('wb') as output:
                while True:
                    data = source.read(65536)
                    if not data: break
                    output.write(data)
                    await asyncio.sleep(0)  # Keep controls, audio capture and cancellation responsive.
            for name in ('LICENSE', 'README.txt'):
                matches = [item for item in package.infolist() if item.filename.rsplit('/', 1)[-1] == name and item.file_size <= 131072]
                if matches: (stage/name).write_bytes(package.read(matches[0]))


def owns_udp_port(pid, port):
    """Confirm the child owns its UDP endpoint without creating an SRT connection."""
    if WINDOWS:
        from ctypes import wintypes as w
        api = ctypes.WinDLL('iphlpapi', use_last_error=True).GetExtendedUdpTable
        api.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.DWORD), w.BOOL, w.ULONG, ctypes.c_int, w.ULONG]
        api.restype = w.DWORD
        size = w.DWORD(0)
        result = api(None, ctypes.byref(size), False, socket.AF_INET, 1, 0)  # UDP_TABLE_OWNER_PID
        if result not in (0, 122) or size.value > 16*1024*1024: raise OSError('Cannot read the UDP listener table')
        for _ in range(3):
            buffer = ctypes.create_string_buffer(size.value)
            result = api(buffer, ctypes.byref(size), False, socket.AF_INET, 1, 0)
            if result == 122: continue
            if result: raise OSError('Cannot read the UDP listener table')
            count = int.from_bytes(buffer.raw[:4], 'little')
            if 4+count*12 > len(buffer): raise OSError('Invalid UDP listener table')
            for offset in range(4, 4+count*12, 12):
                raw = buffer.raw[offset:offset+12]
                if int.from_bytes(raw[8:12], 'little') == pid and socket.ntohs(int.from_bytes(raw[4:8], 'little') & 65535) == port:
                    return True
            return False
        raise OSError('UDP listener table changed during inspection')
    if sys.platform.startswith('linux'):
        # Restricted containers may not expose a process filesystem at all.
        if not Path(f'/proc/{pid}/fd').is_dir(): return None
        owned = set()
        for fd in Path(f'/proc/{pid}/fd').iterdir():
            with contextlib.suppress(OSError): owned.add(os.readlink(fd))
        for line in Path('/proc/net/udp').read_text().splitlines()[1:]:
            fields = line.split()
            if int(fields[1].rsplit(':', 1)[1], 16) == port and 'socket:['+fields[9]+']' in owned:
                return True
        return False
    return None
