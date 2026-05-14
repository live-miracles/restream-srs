#!/usr/bin/env python3
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

proc = None
lock = threading.Lock()


def kill_proc():
    global proc
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    proc = None


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path != "/api/status":
            self.send_response(404)
            self.end_headers()
            return
        with lock:
            running = proc is not None and proc.poll() is None
        self.send_json(200, {"running": running})

    def do_POST(self):
        global proc
        if self.path == "/api/start":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            rtmp_url = data.get("rtmpUrl", "").strip()
            if not rtmp_url.startswith(("rtmp://", "rtmps://")):
                self.send_json(400, {"error": "invalid rtmp url"})
                return
            with lock:
                kill_proc()
                proc = subprocess.Popen(
                    [
                        "ffmpeg",
                        "-i", "rtmp://srs:1935/live/stream",
                        "-c", "copy",
                        "-f", "flv",
                        rtmp_url,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            self.send_json(200, {"ok": True})
        elif self.path == "/api/stop":
            with lock:
                kill_proc()
            self.send_json(200, {"ok": True})
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print("Restreamer listening on :3000", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
