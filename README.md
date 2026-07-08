# restream-srs

Minimal streaming server — takes RTMP/SRT inputs and restreams them to multiple RTMP/SRT outputs. Built on official [SRS](https://github.com/ossrs/srs) for ingest, `srt-bonding-relay` for bonded SRT ingress, and FFmpeg for outputs. Node.js + TypeScript backend.

Designed to handle tens of simultaneous pipelines (inputs) and hundreds of output forwards running continuously across long events. See [Capacity & Limits](#capacity--limits) for the tested envelope.

```
OBS / ffmpeg  ──RTMP────────►  SRS (21935)  ──FFmpeg──►  YouTube / Facebook / ...
              ──SRT─────────►  SRS (10080)  ──FFmpeg──►  rtmp:// or srt://
              ──SRT bonding─►  srt-bonding-relay (10081) ──► SRS
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| srt-bonding-relay | Standalone bonded SRT relay (GitHub release in prod, sibling repo in dev) |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

---

## Capacity & Limits 

The server is built and operated for the envelope below. It has **not** been
tested or designed for anything beyond it — treat these as the supported ceiling,
not a target to exceed :)

| Limit | Supported ceiling |
|-------|-------------------|
| Inputs (pipelines) | up to **50** |
| Outputs (forwards) | up to **500** total |
| Outputs using custom (transcoding) encoding | only **a few** at a time — see below |
| Parallel dashboard clients | up to **~10** |

Past these figures, expect host CPU/RAM/network and the number of concurrent
FFmpeg processes (one per output) to become the limiting factors well before the
dashboard or API does.

**Keep almost all outputs in `copy` mode.** A `copy` output is a passthrough — it
remuxes the input and forwards it with negligible CPU cost, so hundreds can run on
modest hardware. A custom encoding (`720p`, `1080p`, `vertical_rotate`, …) makes
FFmpeg transcode the video, which is CPU-intensive: each such output consumes
roughly a full core's worth of work. **Only a handful of outputs should use custom
encoding at any one time**; everything else should be `copy`. Putting many outputs
into custom-encoding mode will saturate the CPU long before the 500-output ceiling
and starve the `copy` outputs and the dashboard alike.

**Parallel dashboard clients.** Health is computed once every 5s and shared by
all clients, so extra browser tabs do not multiply SRS/SRT-FFprobe work. API
responses are gzip-compressed, and config changes from another session show a
reload banner via the health poll's config revision. Around 10 simultaneous
dashboard clients is fine; higher counts are not tuned or tested.

---

## Running

This app now runs natively on Linux. The production setup uses three systemd services:

| Service | Purpose |
|---------|---------|
| `srs.service` | Native SRS binary, started as `/usr/local/bin/srs -c /etc/restream-srs/srs.conf` |
| `srt-bonding-relay.service` | Shared SRT bonding relay, started on UDP port 10081 |
| `restream-srs.service` | Node.js dashboard/API, started from `/opt/restream-srs/dist/index.js` |

The installer downloads the official SRS release binary and a pinned `srt-bonding-relay` binary from the standalone [`live-miracles/srt-bonding-relay`](https://github.com/live-miracles/srt-bonding-relay) GitHub releases.

Startup is ordered so the Node.js control plane is reachable before SRS accepts
publishes. `srs.service` waits for the unauthenticated readiness endpoint
`http://127.0.0.1:8080/api/ready` before starting; this prevents SRS publish
hooks from racing the dashboard/API process during boot.

**Production install:**
```bash
sudo git clone https://github.com/live-miracles/restream-srs /opt/restream-srs
sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Update an installed server:**
```bash
sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Stop services:**
```bash
sudo bash /opt/restream-srs/scripts/server-down.sh
```

Open the dashboard: `http://SERVER_IP:8080` — default password is `admin`.

### Firewall ports needed

Default ports from `srs.conf` and `srt-bonding-relay.json`:

| Port | Protocol | Purpose |
|------|----------|---------|
| 21935 | TCP | RTMP input (non-default port to avoid 1935 scanner noise) |
| 10080 | UDP | SRT input (passphrase required) |
| 10081 | UDP | SRT bonding input (passphrase required) |
| 8080 | TCP | Dashboard + API |

Do **not** expose 1985 (SRS HTTP API), 8080 (if the dashboard is served through
a tunnel), or 8081 (relay status) — the app talks to those over loopback.

### SRS and SRT relay config

The repository copies both runtime config files during install:
- `/etc/restream-srs/srs.conf`
- `/etc/restream-srs/srt-bonding-relay.json`

SRS only reads its config at startup, and the SRT bonding relay only reads its
JSON config file at startup.

The repo configs ship a public default SRT passphrase; the installer replaces
it with a per-server secret (generated once, kept at
`/etc/restream-srs/.srt-passphrase` and reused across reinstalls) in both
deployed config files. SRS rejects SRT connections without the passphrase at
the handshake, for publish and play alike; the dashboard's SRT publish URLs
include it. To rotate it, delete `.srt-passphrase` and re-run the installer.

Ingest is further locked down by SRS HTTP hooks handled by the app:
`on_publish` rejects unknown stream keys, and `on_play` rejects any play not
from loopback (only the app's own FFmpeg ever pulls streams), so the public
ports are ingest-only. The installer also sets up a fail2ban jail that bans
IPs after repeated rejected publishes/plays.

---

## Authentication

The dashboard is protected by a password (default is `admin`). Change it in **Settings → Change Password** after logging in.

To reset a forgotten password:
```bash
sudo bash /opt/restream-srs/scripts/server-reset-password.sh
```
This resets the password to `admin` and restarts the service.

---

## Publishing to a pipeline

ffmpeg test commands using the default SRT `output_port` (`10080`) from
`srt-bonding-relay.json`:

RTMP:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f flv rtmp://localhost:21935/live/<stream-key>
```

SRT (the passphrase must match `srt_server.passphrase` in `srs.conf`):
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -x264-params "repeat-headers=1" \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16'
```

SRT with multiple audio tracks:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -map 0 \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \
  -x264-params "repeat-headers=1" \
  -force_key_frames 'expr:gte(t,n_forced*2)' -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<passphrase>&pbkeylen=16'
```

---

## API

All routes below sit behind the session-cookie auth middleware except
`/api/ready`, `/api/auth/login`, and the SRS publish hook. An output fans out to
one or more **sinks**; each sink has its own `url` and `audioEncoding`, while
`videoEncoding` is shared per output. The input is pulled back over whatever
protocol it was published with (SRT input → SRT pull, RTMP input → RTMP pull),
so there is no pull-method setting.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Pipelines, outputs, encodings, stream keys, server name |
| GET | `/api/health` | Live input/output status snapshot (refreshed every 5s) |
| GET | `/api/version` | App version / build info |
| GET | `/api/metrics/system` | Host CPU, RAM, disk and network stats |
| GET | `/api/srs-logs` | Recent SRS up/down events and a tail of the SRS log |
| GET | `/api/ready` | Unauthenticated readiness check used by systemd before starting SRS |
| POST | `/api/pipelines` | Create pipeline (auto-names and assigns stream key) |
| GET | `/api/pipelines/:id` | Pipeline details including relay health and bonded-input activity |
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) |
| GET | `/api/pipelines/:id/logs` | Pipeline online/offline event log |
| POST | `/api/pipelines/:id/preview/start` | Start an HLS preview `{ audioTrack? }` |
| POST | `/api/pipelines/:id/preview/stop` | Stop the HLS preview |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, videoEncoding, sinks: [{ url, audioEncoding }] }` |
| POST | `/api/pipelines/:id/outputs/bulk` | Bulk create outputs `{ outputs: [{ name, videoEncoding, sinks }] }` — validates all before creating any |
| DELETE | `/api/pipelines/:id/outputs` | Clear all outputs for the pipeline — returns 409 if any output is still running |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output (same body as create) |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output (stops it first if running) |
| POST | `/api/pipelines/:id/outputs/start-all` | Start all outputs (staggered at 200 ms intervals, returns immediately) |
| POST | `/api/pipelines/:id/outputs/stop-all` | Stop all outputs |
| POST | `/api/pipelines/:id/outputs/:outId/start` | Start output |
| POST | `/api/pipelines/:id/outputs/:outId/stop` | Stop output |
| POST | `/api/settings` | Update settings `{ name, publicHost }` |
| POST | `/api/settings/regenerate-stream-keys` | Regenerate all stream keys |
| POST | `/api/auth/login` | Login `{ password }` — sets session cookie |
| POST | `/api/auth/logout` | Logout — clears session cookie |
| POST | `/api/auth/change-password` | Change password `{ currentPassword, newPassword }` |
| POST | `/api/srs/on_publish` | Unauthenticated SRS publish hook (called by SRS, not the dashboard) |

---

## Development

Prerequisites: Node.js 22+, FFmpeg.

**1. Install dependencies and local media binaries:**
```bash
npm install
npm run dev-install   # downloads SRS into ./objs, no root required
```
Rerunning `npm run dev-install` also refreshes the sibling `../srt-bonding-relay`
repo when it has no local changes and rebuilds `./objs/srt-bonding-relay`.

To use a local SRS binary:
```bash
SRS_LOCAL_BIN=./build/srs npm run dev-install
```

The standalone relay now lives in the sibling `../srt-bonding-relay` repo during development and in `live-miracles/srt-bonding-relay` GitHub Releases for production installs.

**2. Start SRS** (terminal 1):
```bash
npm run srs           # runs ./objs/srs -c srs.conf in the foreground
```

**3. Start the SRT bonding relay** (terminal 2):
```bash
npm run relay         # auto-clones ../srt-bonding-relay if missing, builds it, and runs it (rerun to rebuild after source changes)
```

The relay also exposes a local HTTP status endpoint on the default
`status_port` (`127.0.0.1:8081`) in development. The dashboard backend polls
that endpoint to show the top-level relay health and the per-pipeline
bonded-input status.

**4. Start the app** (terminal 3):
```bash
npm run dev           # tsx watch + tsc watch + tailwind watch
```

---

## Configuration

The app reads runtime settings from `restream.json` in the app root.

`restream.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `8080` | App HTTP port |
| `database_path` | `./db.sqlite` | SQLite database path |
| `srs_config_path` | `./srs.conf` | SRS config path |
| `ffmpeg_path` | `ffmpeg` | FFmpeg binary for outputs and previews |
| `ffprobe_path` | `ffprobe` | FFprobe binary for input media probing and validation |
| `output_watchdog.warmup_ms` | `90000` | Output progress watchdog warmup before stall checks |
| `output_watchdog.stall_ms` | `45000` | Output progress stall window before restarting FFmpeg |
| `output_watchdog.interval_ms` | `5000` | Output watchdog polling interval |
| `output_watchdog.socket_warmup_ms` | `15000` | Socket watchdog warmup before socket-state checks |
| `output_watchdog.socket_grace_ms` | `30000` | Socket warning grace window before restarting FFmpeg |

Relative file paths are resolved from the app root. Command names like `ffmpeg`
and `ffprobe` are left as command names.

SRS values are inferred from `srs.conf`:
- RTMP pull/publish port from top-level `listen`
- SRT pull/publish port from `srt_server { listen ... }`
- SRS HTTP API port from `http_api { listen ... }`
- dashboard log tail path from `srs_log_file`

Relay ports and status polling are read from `srt-bonding-relay.json`, located beside `srs_config_path`.

Installer/development overrides:

| Variable | Used by | Description |
|----------|---------|-------------|
| `REPO_URL` | `server-install.sh` | Repository URL cloned into `/opt/restream-srs` on first install |
| `SRT_RELEASE_TAG` | `server-install.sh` | Relay GitHub release tag to install |
| `SRT_URL` | `server-install.sh` | Custom relay release archive URL |
| `SRT_SHA256` | `server-install.sh` | Expected SHA256 for the relay archive; blank skips verification |
| `WIPE_DB` | `server-install.sh` | Set `y`/`n` to force or skip wiping the existing SQLite DB |
| `SRS_LOCAL_BIN` | `dev-server-install.sh` | Local executable SRS binary to copy into `./objs/srs` |

## Known issues

### Short CPU spikes from host package inventory checks every 10 min

On GCP Ubuntu hosts, `google-osconfig-agent.service` may periodically run
`apt-get update` / package inventory checks and briefly consume a large fraction
of one vCPU. On a 4-vCPU VM this can show up as a ~25% CPU spike. This is host
maintenance noise, not a restream pipeline failure.

Temporary live-event mitigation, cleared automatically on reboot:

```bash
sudo systemctl stop google-osconfig-agent.service
sudo systemctl mask --runtime google-osconfig-agent.service
```

If Ubuntu Pro APT/ESM jobs are also noisy:

```bash
sudo systemctl mask --runtime apt-news.service esm-cache.service
```

This temporarily affects GCP OS patch/inventory reporting or Ubuntu Pro update
messaging; re-enable after the event or reboot.

### SRS `srt_to_rtmp` produces breaking audio (avoided, not used)

SRS's native `srt_to_rtmp` feature (which remuxes an SRT publish into the RTMP
layer so it can be played back over RTMP/HLS) emits audio with bursty,
discontinuous timestamps — roughly 60 ms gaps between 21 ms packets. The
resulting RTMP/HLS plays with constantly breaking/crackling audio, and because
RTMP/FLV carries only one audio stream it also collapses a multi-track SRT source
to a single track. No combination of SRS settings (`hls_dts_directly`, etc.) made
the audio clean.

**How it's avoided:** `srt_to_rtmp` is turned **off** in `srs.conf`. SRT inputs
stay in the native SRT/MPEG-TS domain and are pulled back over SRT (raw MPEG-TS),
which preserves every audio track and keeps timestamps intact; the HLS preview is
generated by the app's own ffmpeg rather than SRS's native HLS. RTMP inputs are
unaffected — they never went through `srt_to_rtmp` — and are pulled over RTMP.

### Watchdogs

The app runs these recovery loops:

| Watchdog | Scope | Restart condition | Notes |
|----------|-------|-------------------|-------|
| Health poll / input recovery | SRS reachability, live pipeline inputs, desired running outputs | When SRS and the pipeline input become ready, outputs whose desired state is `running` are started or restarted with staggered timing | Computed once every 5s and shared by dashboard clients. RTMP inputs become live from SRS stream metadata (codec, dimensions, positive FPS). SRT inputs are probe-gated by ffprobe. |
| Output progress watchdog | Every running FFmpeg output process | After warmup, if the input is ready but FFmpeg `total_size` / `out_time_ms` stop advancing for the configured stall window | Protocol-agnostic backstop; covers SRT outputs and local RTMP relays |
| Remote RTMP socket watchdog | Running outputs with remote RTMP/RTMPS sinks | After socket warmup and grace, if the destination socket is missing or remains in a closing state such as `CLOSE-WAIT` | Uses one `ss -H -tanp` snapshot per watchdog interval; local RTMP/RTMPS sinks are ignored because local input/output sockets are ambiguous |

Both output watchdogs use the same restart path: they write a detailed
`last_error`, kill the stuck FFmpeg process, and let the normal retry loop start a
fresh process while the output's desired state remains `running`. The socket
watchdog is advisory: if `ss` fails or times out, it does not restart anything,
and a socket warning does not prevent the output-progress watchdog from acting.

Input media validation is separate from the output watchdogs. The health service
stays on the regular 5s poll, but it validates media on its own cadence:

| Input check | Scope | Cadence | Notes |
|-------------|-------|---------|-------|
| RTMP initial media validation | Connected RTMP inputs without a successful probe yet | First probe delayed by 5s, then every 15s while failing | Once ffprobe succeeds, RTMP health uses SRS metadata and no longer re-probes that input. |
| SRT media validation | Connected SRT inputs | Every 30s while healthy, every 15s while failing | SRT stays probe-gated because the app pulls SRT inputs back over native SRT/MPEG-TS rather than SRS RTMP remuxing. |

### SRT bonding relay

The relay exists to work around two constraints:

1. **ffmpeg cannot accept bonded SRT group connections.** ffmpeg's SRT handler does not set `SRTO_GROUPCONNECT=1` on its listener socket, so bonded connection attempts from encoders like AJA Bridge Live are rejected at the handshake level.

2. **SRS has no native SRT bonding support.** SRS accepts normal SRT publishers, but it does not accept bonded/redundant SRT groups directly.

**How it is fixed:** `srt-bonding-relay` starts as its own systemd service, listens on `10081` with `SRTO_GROUPCONNECT=1`, accepts each bonded source session, reads its incoming `streamid`, and opens a normal SRT publisher connection to SRS using the same `streamid`. It only connects to SRS after an encoder connects, so SRS's idle-publisher timeout is not triggered by an empty boot-time publisher.

### SRT-input output stalls are recovered by a watchdog

The input is pulled back over its own protocol, so an output on an **SRT input**
always pulls over SRT. When the destination rejects such a stream (e.g. a wrong
YouTube stream key) or drops the RTMP connection mid-publish, ffmpeg can get
stuck instead of exiting. An output on an **RTMP input** (pulled over RTMP)
usually exits ffmpeg immediately with a clear error (`Error opening output files:
Input/output error`).

The difference is timing: with RTMP pull, input stream info is available right
away, so ffmpeg opens the destination immediately and the rejection surfaces at
`write_header` time, exiting non-zero. With SRT pull, ffmpeg must first probe the
MPEG-TS input; by the time it connects, the destination accepts the handshake
then drops the connection mid-publish, and ffmpeg deadlocks — SRT's large input
buffers keep the input thread fed, so the broken-pipe error on the output write
may not propagate promptly. The process can stay alive while buffering input and
consuming RAM even though the external output is no longer uploading.

**How it is handled:** the output service tracks ffmpeg's `-progress pipe:1`
fields (`total_size`, `out_time_ms`, and `bitrate`) plus the stderr tail. It also
takes a single local TCP socket snapshot (`ss -H -tanp`) every watchdog interval
and maps RTMP/RTMPS destination sockets back to each ffmpeg pid. After a warmup
period, an output is marked yellow if its destination socket is missing or in a
closing state such as `CLOSE-WAIT`; if that persists past the socket grace
window, the watchdog records `last_error`, kills that ffmpeg process, and lets
the normal retry loop start a fresh output. The same retry path is used when the
input is live but ffmpeg output bytes/time stop advancing for a sustained window.
The dashboard shows the warning/restart reason and timestamp; the error details
include the pid, stall duration, last ffmpeg progress values, and stderr tail.

**Limitation:** the watchdog monitors aggregate ffmpeg output progress and
pid-level TCP socket state for the process. Local RTMP/RTMPS outputs are excluded
from the TCP socket check because ffmpeg's local input pull and local output push
both connect to local SRS and are ambiguous in `ss`; those relays are still
covered by the output-progress watchdog. For an output that fans out to multiple
sinks, a partial failure may not be identified down to an individual sink if
another sink keeps `total_size` / `out_time_ms` advancing and the socket state is
ambiguous. The common remote one-output-to-one-destination case is fully covered.
