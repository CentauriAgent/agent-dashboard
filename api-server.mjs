import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);
const app = express();
const PORT = 3001;

async function runCmd(cmd, timeoutMs = 10000) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: timeoutMs });
    return stdout.trim();
  } catch (e) {
    return e.stdout?.trim() || JSON.stringify({ error: e.message });
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/sessions', async (req, res) => {
  try {
    const out = await runCmd('openclaw sessions --json 2>&1');
    res.type('json').send(out);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/gateway', async (req, res) => {
  try {
    const ps = await runCmd('ps aux | grep openclaw-gateway | grep -v grep | head -1');
    const uptime = await runCmd("ps -o etime= -p $(pgrep -f openclaw-gateway | head -1) 2>/dev/null || echo 'unknown'");
    let config = {};
    try {
      const home = process.env.HOME;
      const raw = readFileSync(join(home, '.openclaw/openclaw.json'), 'utf8');
      const d = JSON.parse(raw);
      config = { port: d.gateway?.port, mode: d.gateway?.mode, bind: d.gateway?.bind };
    } catch {}
    res.json({ running: ps.length > 0, uptime: uptime.trim(), config });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const out = await runCmd('timeout 5 openclaw health --json 2>&1', 8000);
    try { JSON.parse(out); res.type('json').send(out); } catch { res.json({ raw: out, status: 'unknown' }); }
  } catch (e) {
    res.json({ error: e.message, status: 'error' });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const out = await runCmd('openclaw logs --tail 20 --json 2>&1', 5000);
    const lines = out.split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return { message: l }; } });
    res.json(entries);
  } catch (e) {
    res.json([]);
  }
});

app.listen(PORT, () => console.log(`API server on http://localhost:${PORT}`));
