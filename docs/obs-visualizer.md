# Local OBS music-reactive background

This patch is based on `MagnetosphereLabs/RaveFurry-Dev-Testing`, branch `main`,
commit `252b2e7477c448da56a1d81e503ae5805eac814c`. It adds an independent
audio-analysis companion and its complete OBS background page. Windows is the
primary capture target; Linux uses a PulseAudio-compatible output monitor.

## Files to upload to the dev repository

Keep the ZIP's relative paths when replacing or adding files. The ZIP contains
only these 13 files, not a replacement repository.

| Existing file to replace | Purpose of its changes |
| --- | --- |
| `bin/raveberry` | Starts/stops the optional companion alongside `run`, outside the web/playback child. Adds a separate `visualizer` command. |
| `setup.py` | Packages the companion and defines the optional `visualizer` dependencies. |
| `MANIFEST.in` | Includes the complete HTML and companion files in installation packages. |
| `install-raveberry-windows.cmd` | Installs the extra dependencies from this dev repository's `main`. Retargets an existing frontend checkout to that same repository before updating it. Checks installation failure immediately. |
| `install-raveberry-ubuntu.sh` | Installs the extra dependencies and `pulseaudio-utils` from this dev repository's `main`. |

New files:

- `backend/visualizer/__init__.py`
- `backend/visualizer/capture.py`
- `backend/visualizer/dsp.py`
- `backend/visualizer/service.py`
- `backend/visualizer/supervisor.py`
- `backend/visualizer/obs-background.html`
- `backend/tests/visualizer_test.py`
- `docs/obs-visualizer.md`

Your working Windows start script needs no changes. The patch does not change
the queue, voting, moderation, playback recovery, OBS text exports, or site-mode
implementation. The main production repository is not the installers' target
in this dev-testing bundle.

## Windows installation and OBS setup

1. Upload the files above to their matching paths in the dev repository.
2. At your normal update time, close Raveberry normally. Run the updated
   `install-raveberry-windows.cmd`, keeping your existing environment/configuration
   choices. The installer installs NumPy, aiohttp and PyAudioWPatch; no OBS audio
   plugin, virtual audio cable or separate audio stream is required.
3. Start Raveberry using your existing working start script. Its terminal will
   print `OBS background: http://127.0.0.1:8766/obs-background.html`.
4. In OBS, add a **Browser Source**. Use this URL:
   `http://127.0.0.1:8766/obs-background.html`.
   Set **Width = 1920**, **Height = 1080**, enable **Use custom frame rate**, and
   set **FPS = 60**. Browser-source hardware acceleration must be enabled for
   GPU rendering. These are source settings; they do not change the audio.
5. Put this source behind your existing bars, artwork, title and vote sources.
   Keep your existing OBS music capture. The background itself produces no audio.

Alternatively, check **Local file** in that Browser Source and select the
separately supplied `furatic-obs-background.html`. It is byte-for-byte the same
page packaged as `backend/visualizer/obs-background.html`. It connects to the
same local companion. The served URL keeps the page in step with future app
updates automatically.

The default live page never generates pretend music. To inspect the appearance
without capture, open the served page with `?demo=silence`, `?demo=gentle`,
`?demo=rhythm` or `?demo=intense`. Remove that parameter for real music.

## What happens to the audio

Windows capture uses one persistent, shared-mode WASAPI loopback input stream on
the current default Windows playback endpoint. It reads that endpoint's normal
sample rate and channels and does not create an output stream, change the device,
reroute audio or alter VLC/OBS's audio. Analysis combines spectral power across
channels, so opposite-phase stereo does not disappear in a mono sum.

The fixed 2048-sample FFT produces 48 logarithmically spaced frequency values,
stereo RMS/peak values, bass/mid/treble energy, transient strengths/counters and
rhythmic activity. At 48 kHz the analysis window spans approximately 43 ms.
Metadata is sent up to 50 times per second; GPU animation runs separately at the
Browser Source's selected frame rate. Capture, analysis, delivery and smoothing
all add a short delay; exact synchronization depends on the audio device and OBS
pipeline, and is not a measured zero-latency guarantee.

Raw audio stays in a bounded local capture buffer. Only numeric features and
local capture status cross the WebSocket. There are no audio uploads, external
requests, database checks or music-file requests from this feature.

## Motion and lighting

The blue, purple, orange and green painted clouds travel around the screen in
a separated constellation. Each cloud visits different quadrants rather than
remaining fixed in its original corner. Slow internal texture evolution keeps
the volumes alive. The shared travel path keeps the cloud centers separated and
avoids abrupt repositioning.

Silence keeps a continuous gentle drift. Increasing level and rhythmic activity
smoothly increases travel speed, up to 48 percent over its calm speed; it does
not turn into fast waving or chaotic movement. Position is integrated across
frames, so changing musical intensity does not restart an animation.

Frequency energy illuminates different regions of the clouds. Bass transients
create blue pulses with a smaller warm response; mid/high transients illuminate
the purple cloud. Higher-frequency energy adds fine surface highlights. Each
light uses its cloud's moving coordinates, soft ownership mask and cloud density
to scatter through that volume rather than lighting the whole screen uniformly.
The approved bloom and display treatment is retained. Tone mapping keeps bright
passages controlled behind white OBS labels.

Lights have independent overlapping lifetimes. A new beat does not erase the
previous beat's fade. There is a fixed pool of 64 lights, sized for the detector's
maximum kick/accent rate including the optional cue delay, so very dense passages
cannot grow an unlimited list of effects. Animation phases are computed as
bounded sine/cosine values before reaching the GPU, avoiding the large float time
values that lose precision after days of uptime.

## Resource ownership and recovery

- One companion process, one capture/analysis worker and one launcher supervisor
  thread. Windows PortAudio owns its normal native capture machinery. None are
  created per song, web request, analysis frame or between-song restart.
- Windows capture packets use a four-packet queue. If analysis falls behind,
  older packets are discarded instead of building latency or an expanding queue.
- Both the Windows stream and its PortAudio manager close on every normal or
  error exit of the capture loop. Normal Windows helper shutdown requests a
  graceful stop in its own console process group. If there is no console, or
  the helper hangs, termination is confined to that helper and Windows releases
  its owned handles. A single parent-process handle is closed on helper exit.
- Missing capture samples fade the signal to zero. Silence, an empty queue and
  after-hours mode are healthy idle states and do not trigger helper restarts.
- Capture-device errors retry capture with a 2–30 second backoff. A lost socket
  reconnects with a bounded backoff while the background keeps drifting.
- A dead helper or genuinely stalled worker is recovered by its own supervisor.
  Three failed health checks are required for stall recovery. This code never
  restarts, pauses or sends recovery commands to the web server or music player.
- An occupied local port stops the helper's restart loop. Another port owner's
  process is never killed. Helper shutdown also cleans up its owned Linux
  monitor process; losing the launcher causes the helper to exit.
- At most four socket clients are allowed. A slow socket is dropped after a
  bounded send timeout. No growing frame backlog is retained. Logs rotate at
  approximately 500 KB, with two backups.
- GPU targets are allocated only at initialization, context recovery or resize:
  three textures/framebuffers, three shader programs and one vertex buffer.
  The scene renders up to 1920×1080, with bloom at half resolution. Context
  restoration recreates graphics resources while preserving simulation state.

The listener binds only to `127.0.0.1`, never to a public/LAN interface. Host and
Origin checks reject foreign website requests. Health requests bypass HTTP proxy
environment settings. Do not add this endpoint to a public reverse proxy or
port-forwarding configuration; OBS should use it on this same machine.

## Optional settings and diagnostics

Set these environment variables before starting Raveberry if needed:

| Setting | Effect |
| --- | --- |
| `FURATIC_VISUALIZER=0` | Disables automatic companion startup. |
| `FURATIC_VISUALIZER_PORT=8766` | Changes the local service port. The served page follows its URL's port. For a local-file page, add `?port=YOUR_PORT`. |
| `FURATIC_VISUALIZER_DEVICE` | Windows: explicit WASAPI playback/loopback device index. Linux: explicit monitor-source name. Default is the default output monitor. |

For visible capture status, use
`http://127.0.0.1:8766/obs-background.html?debug=1`.
Windows capture errors are written to
`%LOCALAPPDATA%\Raveberry\visualizer.log`.
`http://127.0.0.1:8766/_healthz/` reports companion health only, not playback health.

If music is routed to a different Windows playback device, activate your usual
Conda environment, run `python -m pyaudiowpatch` to list device indexes, and set
`FURATIC_VISUALIZER_DEVICE` before starting. Automatic recovery reopens failed
streams; an intentional default-output change while the old endpoint remains
active may require restarting the companion or selecting the desired device.

The optional page parameter `?delay=40` delays **new transient light cues** by
40 ms, up to 250 ms. It does not delay continuous frequency levels or change
the actual music. Leave it absent unless you specifically want later light cues.

## Linux / Ubuntu

The patched Ubuntu installer installs the CLI extra and `pulseaudio-utils`.
Capture uses a single `parec` float32 stereo stream on `@DEFAULT_MONITOR@`, with
20 ms requested latency and 10 ms processing intervals. This supports PulseAudio
and a PipeWire session that provides PulseAudio compatibility. The capture user
must have access to the audio session and output monitor.

`raveberry run` starts the companion automatically. For an existing deployment
whose system service runs the web server directly rather than through the CLI,
start `raveberry visualizer` separately using the installer CLI environment, as
the user who owns the audio session. That command uses the same isolated helper
supervisor/recovery, without initializing Django or starting playback. This
patch does not rewrite an existing
Linux systemd/web deployment or move its audio into a different session.

OBS and the capture companion must run on the same machine. A headless server
with no local audio output/monitor will show ambient motion and capture status;
there is no remote audio streaming fallback. Linux logs normally live under
`~/.local/state/Raveberry/visualizer.log`.

## Validation completed for this patch

- 15 automated tests passed: stereo/frequency/transient analysis, bounded buffer,
  capture recovery IDs, Windows native-object cleanup contracts, parent-handle
  lifetime, owned Windows shutdown with/without a console, silence versus
  stalled-worker health, Linux monitor cleanup, local
  HTTP restrictions, socket cap/reconnect, and rejection of socket commands.
- Real helper processes recovered from forced termination and a frozen event
  loop; shut down cleanly; exited after parent death; and preserved an occupied
  port without a restart loop.
- The actual HTML control code passed packet/reconnect, overlapping light
  lifetime, travel through all quadrants, multi-week bounded GPU phase,
  resize/context recovery, dense overlapping onsets and fixed-resource cleanup checks.
- The actual shaders compiled/linked and rendered all four passes in a GLES3
  context, across quiet, rhythmic, intense and migrated-cloud states, including
  a 1920×1080 render and a check that a pulse predominantly lights its own cloud.
  Sampled frames retained approximately 4.7:1 or better white-label contrast.
- A built wheel contained every companion module and the complete HTML; its
  installed-layout CLI served the page and shut down without leaving a listener.
  Python compilation, Ubuntu shell syntax and patch whitespace checks passed.

The test environment was Linux. Windows WASAPI lifetime behavior was checked
with native-API contract doubles; actual Windows endpoint capture, long-term
Windows handle counts, OBS frame pacing and FirePro D300 throughput have not
been measured here. Rendering and recovery tests are evidence about the patch,
not a promise of 60 FPS or zero handle growth on hardware that was not tested.

To rerun the included unit tests from the repository with the extra installed:

```sh
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -p visualizer_test.py -v
```
