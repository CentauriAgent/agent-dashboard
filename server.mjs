import { createServer } from 'http';
import { readFile, readdir, stat } from 'fs/promises';
import { join, extname } from 'path';

const PORT = 5173;
const OPENCLAW_DIR = join(process.env.HOME, '.openclaw');
const SESSIONS_FILE = join(OPENCLAW_DIR, 'agents/main/sessions/sessions.json');
const CRON_FILE = join(OPENCLAW_DIR, 'cron/jobs.json');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');
const DIST_DIR = join(import.meta.dirname, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function getGatewayPid() {
  try {
    const { execSync } = await import('child_process');
    return parseInt(execSync('pgrep -f "openclaw-gateway"', { encoding: 'utf-8', timeout: 2000 }).trim().split('\n')[0]) || null;
  } catch { return null; }
}

async function getUptime() {
  try {
    const pid = await getGatewayPid();
    if (!pid) return null;
    const { execSync } = await import('child_process');
    return execSync(`ps -p ${pid} -o etime=`, { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch { return null; }
}

async function getSessionActivity(sessionsDir) {
  const activity = [];
  try {
    const files = await readdir(sessionsDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).slice(-5);
    for (const file of jsonlFiles) {
      try {
        const content = await readFile(join(sessionsDir, file), 'utf-8');
        const lines = content.trim().split('\n').slice(-10);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.role === 'user' || entry.role === 'assistant') {
              const text = typeof entry.content === 'string'
                ? entry.content.slice(0, 120)
                : entry.content?.[0]?.text?.slice(0, 120) || '';
              if (text && !text.startsWith('<system')) {
                activity.push({ type: entry.role === 'user' ? 'session' : 'system', message: `[${entry.role}] ${text}`, timestamp: entry.ts || Date.now(), sessionFile: file });
              }
            }
            if (entry.role === 'assistant' && Array.isArray(entry.content)) {
              for (const block of entry.content) {
                if (block.type === 'tool_use') {
                  activity.push({ type: 'tool', message: `Tool: ${block.name}`, timestamp: entry.ts || Date.now() });
                }
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return activity.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 20);
}

async function getDashboardData() {
  const [sessionsData, cronData, config] = await Promise.all([
    readJSON(SESSIONS_FILE), readJSON(CRON_FILE), readJSON(CONFIG_FILE),
  ]);

  let skillsCount = 0;
  if (sessionsData) {
    for (const val of Object.values(sessionsData)) {
      if (val.skillsSnapshot?.skills?.length) { skillsCount = val.skillsSnapshot.skills.length; break; }
    }
  }

  const sessions = sessionsData
    ? Object.entries(sessionsData).map(([key, val]) => {
        const { skillsSnapshot, systemPromptReport, ...rest } = val;
        return { key, ...rest };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    : [];

  const cronJobs = cronData?.jobs || [];
  const gatewayPid = await getGatewayPid();
  const uptime = await getUptime();
  const signalStatus = config?.channels?.signal ? 'OK' : 'Not configured';
  const sessionsDir = join(OPENCLAW_DIR, 'agents/main/sessions');
  const activity = await getSessionActivity(sessionsDir);

  return {
    sessions, cronJobs,
    health: { gateway: !!gatewayPid, gatewayPid, signal: signalStatus, uptime, sessions: sessions.length, skills: skillsCount },
    activity, timestamp: Date.now(),
  };
}

async function serveStatic(res, urlPath) {
  let filePath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000' });
    res.end(content);
  } catch {
    // SPA fallback
    try {
      const html = await readFile(join(DIST_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

const server = createServer(async (req, res) => {
  if (req.url === '/api/dashboard') {
    res.setHeader('Content-Type', 'application/json');
    try {
      res.writeHead(200);
      res.end(JSON.stringify(await getDashboardData()));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    await serveStatic(res, req.url);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Centauri Dashboard running at http://localhost:${PORT}`);
  console.log(`   Network: http://192.168.1.5:${PORT}`);
});
