const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

let proc = null;

function killProc() {
  if (proc) {
    proc.kill('SIGTERM');
    proc = null;
  }
}

app.use(express.static(path.join(__dirname, '../player')));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (req, res) => res.sendStatus(200));

app.get('/api/status', (req, res) => {
  res.json({ running: proc !== null });
});

app.post('/api/start', (req, res) => {
  const rtmpUrl = (req.body.rtmpUrl || '').trim();
  if (!rtmpUrl.startsWith('rtmp://') && !rtmpUrl.startsWith('rtmps://')) {
    return res.status(400).json({ error: 'invalid rtmp url' });
  }
  killProc();
  proc = spawn('ffmpeg', [
    '-i', 'rtmp://127.0.0.1:1935/live/stream',
    '-c', 'copy',
    '-f', 'flv',
    rtmpUrl,
  ], { stdio: 'ignore' });
  proc.on('exit', () => { proc = null; });
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  killProc();
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Restreamer listening on :3000'));
