const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 5173;
const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let cachedDashboard = null;
let lastFetch = 0;
const CACHE_TTL = 4000;

function runCmd(cmd) {
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
  } catch (e) {
    return null;
  }
}

function tryJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function getDashboardData() {
  const now = Date.now();
  if (cachedDashboard && (now - lastFetch) < CACHE_TTL) return cachedDashboard;

  const statusRaw = runCmd('openclaw status --all --json 2>/dev/null');
  const healthRaw = runCmd('openclaw health --json 2>/dev/null');

  const status = tryJson(statusRaw);
  const health = tryJson(healthRaw);

  // Build sessions list from status data
  let sessions = [];
  if (status?.sessions?.recent) {
    sessions = status.sessions.recent;
  } else if (status?.sessions?.byAgent) {
    sessions = status.sessions.byAgent.flatMap(a => a.recent || []);
  }

  // Build health info
  let healthInfo = {};
  if (health) {
    healthInfo = {
      gateway: health.ok ? 'OK' : 'Down',
      gatewayPid: health.pid,
      signal: health.channels?.signal?.probe?.ok ? 'OK' : 'Down',
      uptime: health.uptime || null,
      skills: 0,
    };
  } else {
    healthInfo = { gateway: 'Unknown', signal: 'Unknown' };
  }

  const result = {
    sessions,
    health: healthInfo,
    cronJobs: [],
    activity: [],
    gateway: status?.gateway || {},
    agents: status?.agents || {},
    heartbeat: status?.heartbeat || {},
    defaults: status?.sessions?.defaults || {},
  };

  cachedDashboard = result;
  lastFetch = now;
  return result;
}

function serveStatic(req, res) {
  let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url);
  
  // SPA fallback
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST, 'index.html');
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/dashboard' || req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(getDashboardData()));
  } else if (req.url === '/api/health') {
    const raw = runCmd('openclaw health --json 2>/dev/null');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(raw || JSON.stringify({ error: 'unavailable' }));
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Dashboard production server on http://0.0.0.0:${PORT}`);
});
