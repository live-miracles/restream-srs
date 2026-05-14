# restream-srs

Minimal SRT-in → HLS-out preview server using [SRS](https://github.com/ossrs/srs), designed to run on a GCP Ubuntu VM via Docker.

```
OBS / ffmpeg  ──SRT──►  SRS (Docker)  ──HLS──►  Browser player
                :10080                    :8080
```

---

## Files

```
srs.conf            SRS configuration (SRT ingest + HLS output)
docker-compose.yml  Single-container Docker Compose setup
player/index.html   HLS player served by SRS's built-in HTTP server
```

---

## Local Development

Prerequisites: Docker with Compose.

```bash
docker compose up
```

- Player: `http://localhost:8080/player/`
- SRT ingest: `srt://localhost:10080`

Stream a test file with ffmpeg:

```bash
ffmpeg -re -i input.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://localhost:10080?streamid=#!::r=live/stream,mode=publish&pkt_size=1316'
```

To stop:

```bash
docker compose down
```

---

## GCP VM Setup

### 1. Create the VM

Recommended: **e2-small**, Ubuntu 22.04 LTS, 10 GB boot disk.

### 2. Open firewall ports

In **VPC Network → Firewall** (or via `gcloud`), create two ingress rules targeting your VM:

| Rule name        | Protocol / Port | Purpose        |
|------------------|-----------------|----------------|
| `allow-hls`      | TCP 8080        | HTTP + HLS     |
| `allow-srt`      | UDP 10080       | SRT ingest     |

```bash
gcloud compute firewall-rules create allow-hls \
  --allow tcp:8080 --target-tags srs-server

gcloud compute firewall-rules create allow-srt \
  --allow udp:10080 --target-tags srs-server
```

Add the tag `srs-server` to your VM, or drop `--target-tags` to apply to all VMs.

### 3. Install Docker on the VM

SSH into the VM, then:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
```

### 4. Deploy

```bash
git clone https://github.com/YOUR_USERNAME/restream-srs.git
cd restream-srs
docker compose up -d
```

The container starts automatically on every VM boot (`restart: unless-stopped`).

To stop it manually:

```bash
docker compose down
```

---

## Streaming to the server

Replace `EXTERNAL_IP` with your VM's external IP.

```bash
ffmpeg -re -i input.mp4 \
  -c:v libx264 -preset veryfast -b:v 2500k \
  -c:a aac -b:a 128k \
  -f mpegts 'srt://EXTERNAL_IP:10080?streamid=#!::r=live/stream,mode=publish&pkt_size=1316'
```

---

## Viewing the stream

Open in any browser:

```
http://EXTERNAL_IP:8080/player/
```

The page auto-connects and shows **● Live** once a stream is active. It retries automatically if no stream is running yet.

The raw HLS playlist (useful for debugging or external players like VLC):

```
http://EXTERNAL_IP:8080/live/stream.m3u8
```

---

## Logs

```bash
docker compose logs -f
```
