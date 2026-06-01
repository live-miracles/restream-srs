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

**Pipeline IDs:** Gap-filling integers (1, 2, 3 …). If pipeline 2 is deleted, the next created pipeline takes ID 2.  
**Output IDs:** `{pipelineId}-{seq}` (e.g. 1-1, 1-2, 2-1)  
**Stream keys:** 99 pre-generated keys in the format `key01_<random>` … `key99_<random>`. Keys are never deleted — when a pipeline is deleted its key returns to the available pool.

---

## Running

**Production:**
```bash
npm run docker:prod
```

**Development** (hot reload — source changes apply without rebuilding):
```bash
npm run docker:dev
```

Open the dashboard: `http://localhost:8080`

> **WSL users:** Docker Engine must be installed in WSL directly (not just Docker Desktop). See [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

### Firewall ports needed

| Port | Protocol | Purpose |
|------|----------|---------|
| 1935 | TCP | RTMP input |
| 10080 | UDP | SRT input |
| 8080 | TCP | Dashboard + API |

---

## Dashboard

- **Settings** — editable via the gear button next to the title in the navbar; includes server name, SRT latency, and optional SRT passphrase
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
| POST | `/api/settings` | Set server display name, SRT latency, and SRT passphrase `{ name, latency, srtPassphrase }` |
| POST | `/api/settings/server-name` | Set server display name `{ name }` |
| POST | `/api/settings/srt-latency` | Set SRT latency `{ latency }` |

---

## Development

Docker is the recommended way to run locally (`npm run docker:dev`). If you want to run outside Docker:

Prerequisites: Node.js 20+, ffmpeg

```bash
npm install
npm run dev        # tsx watch + tsc watch + tailwind watch
```

Note: this starts only the Node app. SRS (RTMP/SRT ingest) still requires Docker:
```bash
docker compose up srs
```

To rebuild the production image:
```bash
npm run docker:prod --build
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
| `PORT` | `8080` | App HTTP port |
