const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = 5173;
const DIST = path.join(__dirname, 'dist');
const GW_URL = 'ws://127.0.0.1:18789';
const GW_TOKEN = '4e8ff197e5ba65c0ef001e3262f3037d76ac5a6d535545e4';
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = 24 * 60 * 60; // 24 hours in seconds

// --- Device identity for gateway auth (Ed25519) ---
const IDENTITY_DIR = path.join(__dirname, '.device-identity');
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'device.json');

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function loadOrCreateDeviceIdentity() {
  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
        console.log(`Loaded device identity: ${parsed.deviceId.slice(0, 12)}...`);
        return parsed;
      }
    }
  } catch {}
  // Generate new identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem };
  fs.mkdirSync(IDENTITY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  console.log(`Generated new device identity: ${deviceId.slice(0, 12)}...`);
  return identity;
}

function buildDeviceAuthPayload(params) {
  const version = params.nonce ? 'v2' : 'v1';
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token || '',
  ];
  if (version === 'v2') base.push(params.nonce || '');
  return base.join('|');
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

const deviceIdentity = loadOrCreateDeviceIdentity();
let connectNonce = null; // set from challenge event

// Simple JWT using HMAC
function createJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(req) {
  const obj = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) obj[k] = v.join('=');
  });
  return obj;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return cookies.session ? verifyJWT(cookies.session) : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// Cached data
let cachedData = { sessions: [], gateway: {}, health: {}, agents: [], heartbeat: [], cronJobs: [] };
let lastFetch = 0;
const CACHE_TTL = 10000;

let ws = null;
let reqId = 0;
const pending = new Map();

function connectGateway() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(GW_URL, { headers: { Origin: 'http://127.0.0.1:18789' } });

  let connected = false;

  ws.on('open', () => {
    console.log('WS open, waiting for challenge...');
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Handle connect challenge - send connect after receiving it
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        connectNonce = msg.payload?.nonce || null;
        console.log('Got challenge, sending connect with device auth...');
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin'];
        const signedAtMs = Date.now();
        const nonce = connectNonce || undefined;
        const authPayload = buildDeviceAuthPayload({
          deviceId: deviceIdentity.deviceId,
          clientId: 'gateway-client',
          clientMode: 'backend',
          role,
          scopes,
          signedAtMs,
          token: GW_TOKEN,
          nonce,
        });
        const signature = signDevicePayload(deviceIdentity.privateKeyPem, authPayload);
        const publicKeyRaw = base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem));
        sendReq('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: 'gateway-client', displayName: 'Agent Dashboard', version: '1.0.0', platform: 'linux', mode: 'backend' },
          role,
          scopes,
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: GW_TOKEN },
          device: {
            id: deviceIdentity.deviceId,
            publicKey: publicKeyRaw,
            signature,
            signedAt: signedAtMs,
            nonce,
          },
          locale: 'en-US',
          userAgent: 'agent-dashboard/1.0.0',
        }).then((res) => {
          if (res.ok) {
            console.log('Connected to gateway!');
            connected = true;
          } else {
            console.error('Connect rejected:', JSON.stringify(res.error));
          }
        }).catch(e => console.error('Connect error:', e.message));
        return;
      }

      if (msg.type === 'res' && msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Gateway WS closed, reconnecting in 5s...');
    ws = null;
    setTimeout(connectGateway, 5000);
  });

  ws.on('error', (err) => {
    console.error('Gateway WS error:', err.message);
  });
}

function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WS not connected'));
    }
    const id = `dash-${++reqId}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, 8000);
    pending.set(id, { resolve: (msg) => { clearTimeout(timeout); resolve(msg); }, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

async function fetchGatewayData() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL) return cachedData;

  try {
    connectGateway();
    
    // Try to get status and health via WS RPC
    const [statusRes, healthRes] = await Promise.allSettled([
      sendReq('status', {}),
      sendReq('health', {}),
    ]);

    if (statusRes.status === 'fulfilled' && statusRes.value?.ok) {
      const s = statusRes.value.payload;
      cachedData.sessions = s?.sessions?.recent || [];
      cachedData.gateway = s?.gateway || {};
      cachedData.agents = s?.agents?.agents || [];
      cachedData.heartbeat = s?.heartbeat?.agents || [];
    }

    if (healthRes.status === 'fulfilled' && healthRes.value?.ok) {
      cachedData.health = healthRes.value.payload || {};
    }

    cachedData.gateway.reachable = true;
    lastFetch = now;
  } catch (e) {
    cachedData.gateway.reachable = false;
    console.error('Fetch error:', e.message);
  }

  return cachedData;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    // Login/logout don't require auth
    if (url === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.token === GW_TOKEN) {
        const jwt = createJWT({ role: 'operator' });
        res.setHeader('Set-Cookie', `session=${jwt}; HttpOnly; Path=/; Max-Age=${JWT_EXPIRY}; SameSite=Strict`);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid token' }));
      }
      return;
    }

    if (url === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // All other API endpoints require auth
    if (!isAuthed(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const data = await fetchGatewayData();
    const now = Date.now();

    if (url === '/api/dashboard') {
      res.end(JSON.stringify(data));
    } else if (url === '/api/sessions') {
      // Transform to match frontend SessionsData shape
      const sessions = (data.sessions || []).map(s => ({
        ...s,
        ageMs: s.age || (now - (s.updatedAt || now)),
      }));
      res.end(JSON.stringify({ sessions, count: sessions.length, path: '' }));
    } else if (url === '/api/gateway') {
      // Transform to match frontend GatewayData shape
      const gw = data.gateway || {};
      res.end(JSON.stringify({
        running: gw.reachable !== false,
        uptime: data.health?.uptime || gw.self?.uptime || 'unknown',
        config: {
          port: gw.self?.port || 18789,
          mode: gw.mode || 'local',
          bind: gw.self?.host || '127.0.0.1',
        },
      }));
    } else if (url === '/api/health') {
      res.end(JSON.stringify(data.health));
    } else if (url.match(/^\/api\/sessions\/(.+)\/history$/) && req.method === 'GET') {
      const sessionKey = decodeURIComponent(url.match(/^\/api\/sessions\/(.+)\/history$/)[1]);
      try {
        const result = await sendReq('chat.history', { sessionKey, limit: 20 });
        if (result.ok) {
          res.end(JSON.stringify({ ok: true, messages: result.payload?.messages || result.payload || [] }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error?.message || 'Failed to fetch history' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (url === '/api/sessions/stale' && req.method === 'DELETE') {
      try {
        const data = await fetchGatewayData();
        const now = Date.now();
        const stale = (data.sessions || []).filter(s => {
          if (s.key === 'agent:main:main') return false;
          const pct = (s.totalTokens && s.contextTokens) ? (s.totalTokens / s.contextTokens) * 100 : 0;
          if (pct >= 99) return true;
          if (s.key.includes('subagent') && s.ageMs > 3600000) return true;
          return false;
        });
        const results = [];
        for (const s of stale) {
          try {
            const r = await sendReq('sessions.delete', { key: s.key, deleteTranscript: true });
            results.push({ key: s.key, ok: r.ok });
          } catch (e) {
            results.push({ key: s.key, ok: false, error: e.message });
          }
        }
        lastFetch = 0; // bust cache
        res.end(JSON.stringify({ ok: true, deleted: results }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (url.match(/^\/api\/sessions\/(.+)\/send$/) && req.method === 'POST') {
      const sessionKey = decodeURIComponent(url.match(/^\/api\/sessions\/(.+)\/send$/)[1]);
      const body = await readBody(req);
      try {
        const result = await sendReq('chat.send', { sessionKey, message: body.message || '' });
        if (result.ok) {
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error?.message || 'Failed to send' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (url.match(/^\/api\/sessions\/(.+)$/) && req.method === 'DELETE') {
      const sessionKey = decodeURIComponent(url.match(/^\/api\/sessions\/(.+)$/)[1]);
      if (sessionKey === 'agent:main:main') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Cannot delete main session' }));
        return;
      }
      try {
        const result = await sendReq('sessions.delete', { key: sessionKey, deleteTranscript: true });
        if (result.ok) {
          lastFetch = 0;
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error?.message || 'Failed to delete' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.end(JSON.stringify({ error: 'not found' }));
    }
  } else {
    serveStatic(req, res);
  }
});

// Initial connection
connectGateway();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Dashboard on http://0.0.0.0:${PORT}`);
});
