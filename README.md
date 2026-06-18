# restream-srs

Minimal streaming server — takes RTMP/SRT inputs and restreams them to multiple RTMP/SRT outputs. Built on [SRS](https://github.com/ossrs/srs) for ingest and FFmpeg for outputs. Node.js + TypeScript backend.

Designed to handle tens of simultaneous pipelines (inputs) and hundreds of output forwards running continuously across long events.

```
OBS / ffmpeg  ──RTMP──►  SRS (1935)   ──FFmpeg──►  YouTube / Facebook / ...
              ──SRT───►  SRS (10080)  ──FFmpeg──►  rtmp:// or srt://
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| SRS | Ingest broker — accepts RTMP and SRT streams |
| Node.js app | REST API + dashboard on port 8080 |
| FFmpeg | One process per output, spawned and managed by the app |
| SQLite | Persistent state for pipelines, outputs, stream keys, settings |

---

## Running

This app now runs natively on Linux. The production setup uses two systemd services:

| Service | Purpose |
|---------|---------|
| `srs.service` | Native SRS binary, started as `/usr/local/bin/srs -c /etc/restream-srs/srs.conf` |
| `restream-srs.service` | Node.js dashboard/API, started from `/opt/restream-srs/dist/index.js` |

**Production install:**
```bash
sudo git clone https://github.com/live-miracles/restream-srs /opt/restream-srs
sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Update an installed server:**
```bash
sudo bash /opt/restream-srs/scripts/server-update.sh
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
| 8080 | TCP | Dashboard + API |

### SRS config reload

The app writes SRS settings to `/etc/restream-srs/srs.conf`. SRS only reads this file at startup, so changes such as the SRT passphrase require:

```bash
sudo systemctl restart srs.service
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
and `audioEncoding`, while `videoEncoding` and `pullMethod` are shared per output.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Pipelines, outputs, encodings, stream keys, server name |
| GET | `/api/health` | Live input/output status snapshot (refreshed every 5s) |
| GET | `/api/version` | App version / build info |
| GET | `/api/metrics/system` | Host CPU, RAM, disk and network stats |
| GET | `/api/srs-logs` | Recent SRS up/down events and a tail of the SRS log |
| POST | `/api/pipelines` | Create pipeline (auto-names and assigns stream key) |
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) |
| GET | `/api/pipelines/:id/logs` | Pipeline online/offline event log |
| POST | `/api/pipelines/:id/preview/start` | Start an HLS preview `{ audioTrack? }` |
| POST | `/api/pipelines/:id/preview/stop` | Stop the HLS preview |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, videoEncoding, pullMethod, sinks: [{ url, audioEncoding }] }` |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output (same body as create) |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output |
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

Prerequisites: Node.js 20+, FFmpeg.

**1. Install dependencies and the SRS binary:**
```bash
npm install
npm run dev-install   # downloads SRS 6.0-r0 into ./objs/srs, no root required
```

**2. Start SRS** (terminal 1):
```bash
npm run srs           # runs ./objs/srs -c srs.conf in the foreground
```

**3. Start the app** (terminal 2):
```bash
npm run dev           # tsx watch + tsc watch + tailwind watch
```

If the app rewrites `srs.conf` after a passphrase change, restart SRS:
```bash
Ctrl-C  # in terminal 1
npm run srs
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
| `PORT` | `8080` | App HTTP port |

## Known issues

### SRT pull doesn't surface output errors (e.g. wrong stream key) (wontfix)

When an output uses **SRT pull** from SRS and the destination rejects the stream
(e.g. a wrong YouTube stream key), the output gets stuck showing `running`
(yellow) with no error in the logs. With **RTMP pull** the same failure exits
ffmpeg immediately with a clear error (`Error opening output files:
Input/output error`).

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
narrow misconfiguration case. Workaround: use RTMP pull if you need clear error
reporting, or verify the destination stream key before starting an SRT-pull
output.
