# restream-srs

Minimal streaming server — takes RTMP/SRT inputs and restreams them to multiple RTMP/SRT outputs. Built on [SRS](https://github.com/ossrs/srs) for ingest and FFmpeg for outputs. Node.js + TypeScript backend, DaisyUI dashboard.

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

The install script downloads SRS `6.0-r0` by default. To install from an existing Linux SRS binary file instead:
```bash
SRS_BINARY_PATH=/path/to/srs sudo bash /opt/restream-srs/scripts/server-install.sh
```

Set the public host shown in dashboard publish URLs during install:
```bash
PUBLIC_HOST=stream.example.com sudo bash /opt/restream-srs/scripts/server-install.sh
```

**Update an installed server:**
```bash
sudo bash /opt/restream-srs/scripts/server-update.sh
```

**Stop services:**
```bash
sudo bash /opt/restream-srs/scripts/server-down.sh
```

Open the dashboard: `http://SERVER_IP:8080`

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

The Node app does not need to restart for SRT config reloads.

---

## Dashboard

- **Settings** — editable via the gear button next to the title in the navbar; includes server name and optional SRT passphrase
- **Pipelines** — created with one click; auto-named `Pipeline N` and assigned the next available stream key
- **Stream keys** — shown masked (`key01_as...ks`) in the pipeline info panel; copy button copies the full URL
- **Outputs** — per-pipeline list; supports YouTube RTMP, Facebook RTMP, Custom RTMP, Custom SRT; encoding choices include `source`, `720p`, `1080p`, `vertical_rotate`

---

## Publishing to a pipeline

The dashboard shows publish URLs for each pipeline. The stream key is pre-assigned and shown in the pipeline info panel.

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
ffmpeg -re -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f flv rtmp://localhost:1935/live/<stream-key>
```

SRT:
```bash
ffmpeg -re -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish'
```

SRT with passphrase:
```bash
ffmpeg -re -i video.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/<stream-key>,m=publish&passphrase=<srt-passphrase>&pbkeylen=16'
```

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Pipelines, outputs, encodings, stream keys, server name |
| GET | `/health` | Live input/output status |
| POST | `/api/pipelines` | Create pipeline (auto-names and assigns stream key) |
| POST | `/api/pipelines/:id` | Rename pipeline `{ name }`, optionally reassign key `{ name, streamKeyId }` |
| DELETE | `/api/pipelines/:id` | Delete pipeline (stream key is freed, not deleted) |
| POST | `/api/pipelines/:id/outputs` | Create output `{ name, url, encoding }` |
| POST | `/api/pipelines/:id/outputs/:outId` | Update output |
| DELETE | `/api/pipelines/:id/outputs/:outId` | Delete output |
| POST | `/api/pipelines/:id/outputs/:outId/start` | Start output |
| POST | `/api/pipelines/:id/outputs/:outId/stop` | Stop output |
| POST | `/api/settings` | Set server display name and SRT passphrase `{ name, srtPassphrase }` |
| POST | `/api/settings/server-name` | Set server display name `{ name }` |

---

## Development

Prerequisites: Node.js 20+, FFmpeg.

**1. Install dependencies and the SRS binary:**
```bash
npm install
npm run dev-install   # downloads SRS 6.0-r0 into ./objs/srs, no root required
```

To use a local SRS binary instead of downloading:
```bash
SRS_BINARY_PATH=/path/to/srs npm run dev-install
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
| `PUBLIC_HOST` | `localhost` | Host shown in publish URL hints in the dashboard |
| `DB_PATH` | `./data.db` | SQLite database path |
| `SRS_CONF_PATH` | `./srs.conf` | SRS config path written by the app |
| `PORT` | `8080` | App HTTP port |
