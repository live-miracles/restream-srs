# restream-srs

Minimal streaming server — takes RTMP/SRT inputs and restreams them to multiple RTMP/SRT outputs. Built on official [SRS](https://github.com/ossrs/srs) for ingest, `srt-bonding-relay` for bonded SRT ingress, and FFmpeg for outputs. Node.js + TypeScript backend.

Designed to handle tens of simultaneous pipelines (inputs) and hundreds of output forwards running continuously across long events. See [Capacity & Limits](#capacity--limits) for the tested envelope.

```
OBS / ffmpeg  ──RTMP────────►  SRS (1935)   ──FFmpeg──►  YouTube / Facebook / ...
              ──SRT─────────►  SRS (10080)  ──FFmpeg──►  rtmp:// or srt://
              ──SRT bonding─►  srt-bonding-relay (10081) ──► SRS
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| srt-bonding-relay | Shared SRT bonding relay into SRS |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

---

## Capacity & Limits 

The server is built and operated for the envelope below. It has **not** been
tested or designed for anything beyond it — treat these as the supported ceiling,
not a target to exceed.

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

**Parallel dashboard clients.** The dashboard fans out cheaply to multiple
viewers: input/output health is computed once per 5s on the server and cached, so
additional browser clients read that shared snapshot rather than multiplying
SRS/FFprobe work. API responses are gzip-compressed to keep the per-client
bandwidth low. When one client changes the configuration (adds/edits/removes a
pipeline or output, etc.), the others detect it via a config revision carried on
the health poll and show a "Configuration was changed in another session" banner
with a Reload button, so no client silently shows stale structure. Around 10
simultaneous dashboard clients is fine within the limits above; the server has not
been tuned or tested for substantially more.

---

## Running

This app now runs natively on Linux. The production setup uses two systemd services:

| Service | Purpose |
|---------|---------|
| `srs.service` | Native SRS binary, started as `/usr/local/bin/srs -c /etc/restream-srs/srs.conf` |
| `srt-bonding-relay.service` | Shared SRT bonding relay, started on UDP port 10081 |
| `restream-srs.service` | Node.js dashboard/API, started from `/opt/restream-srs/dist/index.js` |

The installer downloads the official SRS release binary and a pinned `srt-bonding-relay` binary from this project's GitHub releases. The relay asset is built separately from Haivision's official SRT source and verified by SHA256 during install.

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

| Port | Protocol | Purpose |
|------|----------|---------|
| 1935 | TCP | RTMP input |
| 10080 | UDP | SRT input |
| 10081 | UDP | SRT bonding input |
| 8080 | TCP | Dashboard + API |

### SRS config reload

The app writes both SRT runtime config files together:
- `/etc/restream-srs/srs.conf`
- `/etc/restream-srs/srt-bonding-relay.env`

SRS only reads its config at startup, and the SRT bonding relay only reads its
env file at startup, so SRT passphrase changes require:

```bash
sudo systemctl restart srs.service
```

```bash
sudo systemctl restart srs.service srt-bonding-relay.service
```

---

## Authentication

The dashboard is protected by a password. Default password on first run is `admin`. Change it in **Settings → Change Password** after logging in. Logout is also available from Settings.

To reset a forgotten password:
```bash
sudo bash /opt/restream-srs/scripts/server-reset-password.sh
```
This resets the password to `admin` and restarts the service.

---

## Publishing to a pipeline

The dashboard shows publish URLs for each pipeline. The stream key is pre-assigned and shown in the pipeline info panel. The host in the URLs reflects the **Public Host** set in Settings (defaults to `localhost` — set it to your server IP or domain after install).

**RTMP:**
```
rtmp://YOUR_HOST:1935/live/key01_<random>
```

**SRT:**
```
srt://YOUR_HOST:10080?streamid=#!::r=live/key01_<random>,m=publish
```

When an SRT passphrase is configured, the dashboard appends `passphrase` and `pbkeylen=16` to the publish URL. Clients without the matching passphrase are rejected by SRS during the SRT handshake.

**SRT bonding (path redundancy):** `srt-bonding-relay.service` starts on boot and listens on UDP port `10081`. It accepts bonded SRT groups, forwards the deduplicated stream into SRS on `10080`, and preserves the incoming SRT stream ID. Configure all redundant encoder paths to the bonding URL shown in the pipeline details, for example:

```
srt://YOUR_HOST:10081?mode=caller&grouptype=broadcast&streamid=#!::r=live/key01_<random>,m=publish
```

The dashboard exposes copy buttons for the bonding IP, port and full URL.

When an SRT passphrase is configured, the dashboard appends `passphrase` and `pbkeylen=16` to the bonding URL and the relay also uses that passphrase when publishing into SRS.

ffmpeg test commands:

RTMP:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f flv rtmp://localhost:1935/live/<stream-key>
```

SRT:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -x264-params "repeat-headers=1" \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish'
```

SRT with passphrase:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -x264-params "repeat-headers=1" \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<srt-passphrase>&pbkeylen=16'
```

SRT with multiple audio tracks (use `-map 0` to include all streams from the source).
`-force_key_frames`/`-tune zerolatency` keep a self-contained keyframe every 2s so
late-joining SRT readers (VLC, ffplay, the dashboard preview) can sync quickly — without
it they stall waiting for the source's sparse keyframes.
`-x264-params "repeat-headers=1"` embeds SPS/PPS in every IDR frame so players that
join mid-stream (or reconnect) can decode immediately without missing the parameter sets
sent at stream start:
```bash
ffmpeg -re -stream_loop -1 -i video.mp4 \
  -map 0 \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \
  -x264-params "repeat-headers=1" \
  -force_key_frames 'expr:gte(t,n_forced*2)' -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish'
```

To pull the stream back for inspection (e.g. VLC, ffplay), encode the `#` in the
streamid as `%23` — VLC otherwise treats it as a URL fragment:
```
srt://localhost:10080?streamid=%23!::r=live/<stream-key>,m=request
```

---

## API

All routes below sit behind the session-cookie auth middleware (except the SRS
hook). An output fans out to one or more **sinks**; each sink has its own `url`
and `audioEncoding`, while `videoEncoding` is shared per output. The input is
pulled back over whatever protocol it was published with (SRT input → SRT pull,
RTMP input → RTMP pull), so there is no pull-method setting.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Pipelines, outputs, encodings, stream keys, server name |
| GET | `/api/health` | Live input/output status snapshot (refreshed every 5s) |
| GET | `/api/version` | App version / build info |
| GET | `/api/metrics/system` | Host CPU, RAM, disk and network stats |
| GET | `/api/srs-logs` | Recent SRS up/down events and a tail of the SRS log |
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
| POST | `/api/settings` | Update settings `{ name, srtPassphrase, publicHost }` |
| POST | `/api/settings/regenerate-stream-keys` | Regenerate all stream keys |
| POST | `/api/auth/login` | Login `{ password }` — sets session cookie |
| POST | `/api/auth/logout` | Logout — clears session cookie |
| POST | `/api/auth/change-password` | Change password `{ currentPassword, newPassword }` |
| POST | `/api/srs/on_publish` | SRS publish hook (called by SRS, not the dashboard) |

---

## Development

Prerequisites: Node.js 22+, FFmpeg.

**1. Install dependencies and local media binaries:**
```bash
npm install
npm run dev-install   # downloads SRS into ./objs, no root required
```

To use a local SRS binary:
```bash
SRS_LOCAL_BIN=./build/srs npm run dev-install
```

**Publishing a new pinned `srt-bonding-relay` release asset** (requires Docker and `gh`):
```bash
bash scripts/build-srt-bonding-relay.sh

# Upload to GitHub releases (bump the tag for each new build).
gh release create srt-v1.5.5-2 "./build/srt-bonding-relay-linux-x86_64.tar.gz" \
  --repo live-miracles/restream-srs \
  --title "srt-bonding-relay v1.5.5" \
  --notes "Built from Haivision/srt v1.5.5 for restream-srs."

# Update SRT_RELEASE_TAG and SRT_SHA256 in scripts/server-install.sh
# if the version or hash changed.
```

**2. Start SRS** (terminal 1):
```bash
npm run srs           # runs ./objs/srs -c srs.conf in the foreground
```

**3. Start the SRT bonding relay** (terminal 2):
```bash
npm run relay         # Docker-builds the relay, runs it, and rebuilds/restarts on native/ changes
```

The relay also exposes a local HTTP status endpoint on `127.0.0.1:10082` in
development. The dashboard backend polls that endpoint to show the top-level
relay health and the per-pipeline bonded-input status.

**4. Start the app** (terminal 3):
```bash
npm run dev           # tsx watch + tsc watch + tailwind watch
```

If the app rewrites `srs.conf` and `srt-bonding-relay.env` after a passphrase change, restart SRS and the relay:
```bash
Ctrl-C  # in terminal 1
npm run srs
Ctrl-C  # in terminal 2
npm run relay
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SRS_API_URL` | `http://localhost:1985` | SRS HTTP API URL |
| `SRS_RTMP_HOST` | `localhost` | SRS RTMP host (for FFmpeg to pull from) |
| `SRS_RTMP_PORT` | `1935` | SRS RTMP port |
| `SRS_SRT_PORT` | `10080` | SRS SRT port (for FFmpeg to pull from) |
| `DB_PATH` | `./data.db` | SQLite database path |
| `SRS_CONF_PATH` | `./srs.conf` | SRS config path written by the app |
| `SRS_LOG_PATH` | `./objs/srs.log` | SRS log path read for the dashboard log tail |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg binary (uses `$PATH` if unset) |
| `FFPROBE_PATH` | `ffprobe` | FFprobe binary (uses `$PATH` if unset) |
| `SRT_BONDING_PORT` | `10081` | Shared SRT bonding listener port |
| `SRT_BONDING_RELAY_ENV_PATH` | beside `srs.conf` | Env file consumed by `srt-bonding-relay.service` |
| `PORT` | `8080` | App HTTP port |

## Known issues

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

### SRT bonding relay

The relay exists to work around two constraints:

1. **ffmpeg cannot accept bonded SRT group connections.** ffmpeg's SRT handler does not set `SRTO_GROUPCONNECT=1` on its listener socket, so bonded connection attempts from encoders like AJA Bridge Live are rejected at the handshake level.

2. **SRS has no native SRT bonding support.** SRS accepts normal SRT publishers, but it does not accept bonded/redundant SRT groups directly.

**How it is fixed:** `srt-bonding-relay` starts as its own systemd service, listens on `10081` with `SRTO_GROUPCONNECT=1`, accepts each bonded source session, reads its incoming `streamid`, and opens a normal SRT publisher connection to SRS using the same `streamid`. It only connects to SRS after an encoder connects, so SRS's idle-publisher timeout is not triggered by an empty boot-time publisher.

### SRT-input outputs don't surface output errors (e.g. wrong stream key) (wontfix)

The input is pulled back over its own protocol, so an output on an **SRT input**
always pulls over SRT. When the destination rejects such a stream (e.g. a wrong
YouTube stream key), the output gets stuck showing `running` (yellow) with no
error in the logs. An output on an **RTMP input** (pulled over RTMP) exits ffmpeg
immediately with a clear error (`Error opening output files: Input/output
error`).

The difference is timing: with RTMP pull, input stream info is available right
away, so ffmpeg opens the destination immediately and the rejection surfaces at
`write_header` time, exiting non-zero. With SRT pull, ffmpeg must first probe the
MPEG-TS input; by the time it connects, the destination accepts the handshake
then drops the connection mid-publish, and ffmpeg deadlocks — SRT's large input
buffers keep the input thread fed, so the broken-pipe error on the output write
never propagates. The process never exits, so no error is ever logged.

**Why wontfix:** this isn't fixable via ffmpeg flags — native RTMP ignores
`rw_timeout`, and librtmp isn't compiled into the ffmpeg build; `linger=0` /
input-side timeouts don't help because the input isn't the thing stalling. The
only reliable fix is an app-side no-progress watchdog (kill an output that stays
`running` with zero progress past a grace period), which adds complexity for a
narrow misconfiguration case. Workaround: verify the destination stream key
before starting an output on an SRT input (pull method is no longer selectable —
it follows the input protocol).
