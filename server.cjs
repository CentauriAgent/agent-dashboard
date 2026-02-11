const { execSync } = require('child_process');
const http = require('http');

const PORT = 3001;

function runCmd(cmd) {
  try {
    return execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
  } catch (e) {
    return e.stdout || e.message;
  }
}

function tryJson(raw) {
  try { return JSON.parse(raw); } catch { return { raw }; }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/api/status') {
    const raw = runCmd('openclaw status --all --json 2>/dev/null || openclaw status --all 2>&1');
    res.end(JSON.stringify(tryJson(raw)));
  } else if (req.url === '/api/health') {
    const raw = runCmd('openclaw health --json 2>&1');
    res.end(JSON.stringify(tryJson(raw)));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
