import { createSignal, createResource, onCleanup, For, Show } from 'solid-js';

// Types
interface Session {
  key: string;
  kind: string;
  updatedAt: number;
  ageMs: number;
  sessionId: string;
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  channel?: string;
  flags?: string[];
  labels?: string[];
}

interface SessionsData {
  sessions: Session[];
  count: number;
  path: string;
}

interface GatewayData {
  running: boolean;
  uptime: string;
  config: { port?: number; mode?: string; bind?: string };
}

interface HistoryMessage {
  role: string;
  content: string;
  [key: string]: any;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

// Auth state
const [authed, setAuthed] = createSignal(true);
const [loginError, setLoginError] = createSignal('');

// Toast state
const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastId = 0;

function addToast(message: string, type: 'success' | 'error' = 'success') {
  const id = ++toastId;
  setToasts(t => [...t, { id, message, type }]);
  setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
}

// Fetchers
const fetchJson = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 401) { setAuthed(false); throw new Error('unauthorized'); }
  return res.json();
};

// Helpers
function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

function formatTokens(n?: number): string {
  if (!n) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function sessionName(key: string): string {
  const parts = key.split(':');
  if (parts.length <= 2) return key;
  const last = parts[parts.length - 1];
  if (parts.includes('subagent')) return `🤖 sub:${last.slice(0, 8)}`;
  if (parts.includes('signal')) return `📱 signal:${last.slice(0, 12)}`;
  if (parts.includes('main')) return '⭐ main';
  return key.slice(0, 30);
}

function tokenPercent(session: Session): number {
  if (!session.totalTokens || !session.contextTokens) return 0;
  return Math.min(100, (session.totalTokens / session.contextTokens) * 100);
}

function truncateContent(content: string, max: number = 300): string {
  if (!content) return '';
  if (content.length <= max) return content;
  return content.slice(0, max) + '…';
}

// Components
function GaugeRing(props: { percent: number; size?: number; color?: string; label: string }) {
  const size = () => props.size || 80;
  const r = () => (size() - 8) / 2;
  const circ = () => 2 * Math.PI * r();
  const offset = () => circ() * (1 - props.percent / 100);
  const color = () => {
    if (props.percent > 80) return '#ef4444';
    if (props.percent > 50) return '#f59e0b';
    return props.color || '#3b82f6';
  };

  return (
    <div class="flex flex-col items-center gap-1">
      <svg width={size()} height={size()} class="transform -rotate-90">
        <circle cx={size() / 2} cy={size() / 2} r={r()} fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="6" />
        <circle
          cx={size() / 2} cy={size() / 2} r={r()}
          fill="none" stroke={color()} stroke-width="6"
          stroke-dasharray={circ()} stroke-dashoffset={offset()}
          stroke-linecap="round" class="gauge-ring"
        />
      </svg>
      <span class="text-xs text-gray-400">{props.label}</span>
      <span class="text-sm font-mono font-medium text-white">{props.percent.toFixed(0)}%</span>
    </div>
  );
}

function ToastContainer() {
  return (
    <div class="fixed top-4 right-4 z-[100] flex flex-col gap-2">
      <For each={toasts()}>
        {(toast) => (
          <div class={`px-4 py-3 rounded-lg text-sm font-medium shadow-lg animate-fade-in ${
            toast.type === 'success' 
              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300' 
              : 'bg-red-500/20 border border-red-500/30 text-red-300'
          }`}>
            {toast.type === 'success' ? '✅ ' : '❌ '}{toast.message}
          </div>
        )}
      </For>
    </div>
  );
}

function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; loading?: boolean; destructive?: boolean }) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={props.onCancel}>
      <div class="glass-card p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 class="text-lg font-semibold text-white mb-2">{props.title}</h3>
        <p class="text-sm text-gray-400 mb-6">{props.message}</p>
        <div class="flex gap-3 justify-end">
          <button
            onClick={props.onCancel}
            disabled={props.loading}
            class="px-4 py-2 rounded-lg text-sm text-gray-400 border border-white/10 hover:border-white/20 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={props.onConfirm}
            disabled={props.loading}
            class={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-50 ${
              props.destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {props.loading ? 'Working...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionDetailPanel(props: { session: Session; onClose: () => void; onDeleted: () => void }) {
  const s = () => props.session;
  const pct = () => tokenPercent(s());
  const [history, setHistory] = createSignal<HistoryMessage[]>([]);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal('');
  const [sendMsg, setSendMsg] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  const isMain = () => s().key === 'agent:main:main';

  // Fetch history on mount
  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s().key)}/history`);
      const data = await res.json();
      if (data.ok) {
        setHistory(Array.isArray(data.messages) ? data.messages : []);
      } else {
        setHistoryError(data.error || 'Failed to load');
      }
    } catch (e: any) {
      setHistoryError(e.message);
    }
    setHistoryLoading(false);
  };

  loadHistory();

  const handleSend = async () => {
    if (!sendMsg().trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s().key)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: sendMsg() }),
      });
      const data = await res.json();
      if (data.ok) {
        addToast('Message sent');
        setSendMsg('');
        setTimeout(loadHistory, 1000);
      } else {
        addToast(data.error || 'Send failed', 'error');
      }
    } catch (e: any) {
      addToast(e.message, 'error');
    }
    setSending(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s().key)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        addToast('Session deleted');
        setShowDeleteConfirm(false);
        props.onDeleted();
      } else {
        addToast(data.error || 'Delete failed', 'error');
      }
    } catch (e: any) {
      addToast(e.message, 'error');
    }
    setDeleting(false);
  };

  const barColor = () => pct() > 80 ? '#ef4444' : pct() > 50 ? '#f59e0b' : '#3b82f6';

  return (
    <>
      {/* Backdrop */}
      <div class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={props.onClose} />
      
      {/* Panel */}
      <div class="fixed top-0 right-0 bottom-0 z-50 w-full max-w-lg bg-[#0d1117]/95 border-l border-white/10 overflow-y-auto shadow-2xl slide-in-right">
        {/* Header */}
        <div class="sticky top-0 bg-[#0d1117]/90 backdrop-blur-md border-b border-white/10 p-5 flex items-center justify-between z-10">
          <div>
            <h2 class="text-lg font-semibold text-white">{sessionName(s().key)}</h2>
            <p class="text-xs text-gray-500 font-mono mt-0.5">{s().key}</p>
          </div>
          <button onClick={props.onClose} class="text-gray-500 hover:text-white text-xl transition-colors p-1">✕</button>
        </div>

        <div class="p-5 space-y-6">
          {/* Session Info */}
          <div class="glass-card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-300 mb-3">📋 Session Info</h3>
            <div class="grid grid-cols-2 gap-3 text-xs">
              <div><span class="text-gray-500">Session ID</span><p class="text-gray-300 font-mono mt-0.5">{s().sessionId?.slice(0, 16) || 'n/a'}</p></div>
              <div><span class="text-gray-500">Kind</span><p class="text-gray-300 mt-0.5">{s().kind}</p></div>
              <div><span class="text-gray-500">Model</span><p class="text-gray-300 font-mono mt-0.5">{s().model || 'n/a'}</p></div>
              <div><span class="text-gray-500">Channel</span><p class="text-gray-300 mt-0.5">{s().channel || 'n/a'}</p></div>
              <div><span class="text-gray-500">Last Active</span><p class="text-gray-300 mt-0.5">{formatAge(s().ageMs)}</p></div>
              <div><span class="text-gray-500">Tokens In</span><p class="text-gray-300 font-mono mt-0.5">{formatTokens(s().inputTokens)}</p></div>
              <div><span class="text-gray-500">Tokens Out</span><p class="text-gray-300 font-mono mt-0.5">{formatTokens(s().outputTokens)}</p></div>
              <div><span class="text-gray-500">Total Tokens</span><p class="text-gray-300 font-mono mt-0.5">{formatTokens(s().totalTokens)}</p></div>
            </div>
          </div>

          {/* Context Usage Gauge */}
          <Show when={s().totalTokens && s().contextTokens}>
            <div class="glass-card p-4">
              <h3 class="text-sm font-semibold text-gray-300 mb-4">📊 Context Usage</h3>
              <div class="flex items-center gap-4">
                <GaugeRing percent={pct()} size={100} label="Context" />
                <div class="flex-1 space-y-2">
                  <div class="w-full h-3 bg-white/5 rounded-full overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-1000" style={{ width: `${pct()}%`, background: barColor() }} />
                  </div>
                  <div class="flex justify-between text-xs text-gray-500">
                    <span>{formatTokens(s().totalTokens)} used</span>
                    <span>{formatTokens(s().contextTokens)} max</span>
                  </div>
                </div>
              </div>
            </div>
          </Show>

          {/* Flags & Labels */}
          <Show when={(s().flags && s().flags!.length > 0) || (s().labels && s().labels!.length > 0) || s().systemSent || s().abortedLastRun}>
            <div class="glass-card p-4">
              <h3 class="text-sm font-semibold text-gray-300 mb-3">🏷️ Flags & Labels</h3>
              <div class="flex flex-wrap gap-2">
                <Show when={s().systemSent}><span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">system-sent</span></Show>
                <Show when={s().abortedLastRun}><span class="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">aborted</span></Show>
                <For each={s().flags || []}>
                  {(f) => <span class="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">{f}</span>}
                </For>
                <For each={s().labels || []}>
                  {(l) => <span class="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">{l}</span>}
                </For>
              </div>
            </div>
          </Show>

          {/* Transcript */}
          <div class="glass-card p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-300">💬 Recent Messages</h3>
              <button onClick={loadHistory} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">↻ Refresh</button>
            </div>
            <Show when={historyLoading()}>
              <div class="text-center py-4"><span class="text-gray-500 text-sm">Loading...</span></div>
            </Show>
            <Show when={historyError()}>
              <div class="text-center py-4"><span class="text-red-400 text-sm">{historyError()}</span></div>
            </Show>
            <Show when={!historyLoading() && !historyError()}>
              <Show when={history().length > 0} fallback={<p class="text-gray-600 text-sm text-center py-4">No messages</p>}>
                <div class="space-y-3 max-h-80 overflow-y-auto">
                  <For each={history().slice(-20)}>
                    {(msg) => (
                      <div class={`text-xs p-3 rounded-lg ${
                        msg.role === 'assistant' ? 'bg-blue-500/10 border border-blue-500/20' :
                        msg.role === 'user' ? 'bg-white/5 border border-white/10' :
                        'bg-purple-500/10 border border-purple-500/20'
                      }`}>
                        <span class={`font-semibold ${
                          msg.role === 'assistant' ? 'text-blue-400' :
                          msg.role === 'user' ? 'text-gray-300' :
                          'text-purple-400'
                        }`}>{msg.role}</span>
                        <p class="text-gray-400 mt-1 whitespace-pre-wrap break-words font-mono leading-relaxed">
                          {truncateContent(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))}
                        </p>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>

          {/* Send Message */}
          <div class="glass-card p-4">
            <h3 class="text-sm font-semibold text-gray-300 mb-3">📤 Send Message</h3>
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Type a message..."
                value={sendMsg()}
                onInput={(e) => setSendMsg(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm placeholder-gray-600 outline-none focus:border-blue-500/50"
              />
              <button
                onClick={handleSend}
                disabled={sending() || !sendMsg().trim()}
                class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {sending() ? '...' : 'Send'}
              </button>
            </div>
          </div>

          {/* Delete */}
          <Show when={!isMain()}>
            <div class="glass-card p-4">
              <h3 class="text-sm font-semibold text-gray-300 mb-3">⚠️ Danger Zone</h3>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                class="px-4 py-2 rounded-lg bg-red-600/20 border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-600/30 transition-colors"
              >
                🗑️ Delete Session
              </button>
            </div>
          </Show>
        </div>
      </div>

      <Show when={showDeleteConfirm()}>
        <ConfirmDialog
          title="Delete Session"
          message={`Are you sure you want to delete "${sessionName(s().key)}"? This will also delete the transcript.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          loading={deleting()}
          destructive={true}
        />
      </Show>
    </>
  );
}

function LoginPage() {
  const [token, setToken] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token() }),
      });
      if (res.ok) {
        setAuthed(true);
      } else {
        setLoginError('Invalid token');
      }
    } catch {
      setLoginError('Connection error');
    }
    setLoading(false);
  };

  return (
    <div class="min-h-screen flex items-center justify-center">
      <div class="fixed inset-0 pointer-events-none overflow-hidden">
        <div class="absolute -top-40 -left-40 w-96 h-96 bg-accent-blue/5 rounded-full blur-3xl" />
        <div class="absolute -bottom-40 -right-40 w-96 h-96 bg-accent-purple/5 rounded-full blur-3xl" />
      </div>
      <div class="glass-card p-8 w-full max-w-sm relative z-10">
        <div class="text-center mb-6">
          <div class="text-4xl mb-2">🦞</div>
          <h1 class="text-xl font-bold gradient-text">Agent Command Center</h1>
          <p class="text-sm text-gray-500 mt-1">Enter gateway token to continue</p>
        </div>
        <form onSubmit={handleLogin}>
          <input
            type="password"
            placeholder="Gateway token"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
            class="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 outline-none focus:border-blue-500/50 font-mono text-sm mb-4"
          />
          <Show when={loginError()}>
            <p class="text-red-400 text-sm mb-3">{loginError()}</p>
          </Show>
          <button
            type="submit"
            disabled={loading()}
            class="w-full py-3 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading() ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Header(props: { gatewayRunning: boolean; onCleanStale: () => void; cleaningStale: boolean }) {
  const handleLogout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    setAuthed(false);
  };

  return (
    <header class="flex items-center justify-between px-8 py-6">
      <div class="flex items-center gap-4">
        <div class="text-3xl">🦞</div>
        <div>
          <h1 class="text-2xl font-bold gradient-text">Agent Command Center</h1>
          <p class="text-sm text-gray-500 mt-0.5">OpenClaw Dashboard</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          onClick={props.onCleanStale}
          disabled={props.cleaningStale}
          class="text-xs px-3 py-1.5 rounded-lg bg-amber-600/20 border border-amber-500/30 text-amber-400 hover:bg-amber-600/30 transition-colors disabled:opacity-50"
        >
          {props.cleaningStale ? '🧹 Cleaning...' : '🧹 Clean Stale'}
        </button>
        <div class={`status-dot ${props.gatewayRunning ? 'bg-emerald-400' : 'bg-red-500'}`} />
        <span class="text-sm text-gray-400">
          Gateway {props.gatewayRunning ? 'Online' : 'Offline'}
        </span>
        <span class="text-xs text-gray-600 font-mono ml-4">
          {new Date().toLocaleTimeString()}
        </span>
        <button
          onClick={handleLogout}
          class="ml-4 text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded border border-white/10 hover:border-white/20"
        >
          Logout
        </button>
      </div>
    </header>
  );
}

function SessionCard(props: { session: Session; index: number; onClick: () => void }) {
  const s = () => props.session;
  const pct = () => tokenPercent(s());
  const barColor = () => pct() > 80 ? 'bg-red-500' : pct() > 50 ? 'bg-amber-500' : 'bg-accent-blue';

  return (
    <div
      class="glass-card p-5 animate-fade-in cursor-pointer hover:border-white/20 transition-all hover:scale-[1.01]"
      style={{ "animation-delay": `${props.index * 80}ms` }}
      onClick={props.onClick}
    >
      <div class="flex items-start justify-between mb-3">
        <div>
          <h3 class="font-semibold text-white text-sm">{sessionName(s().key)}</h3>
          <p class="text-xs text-gray-500 font-mono mt-1">{s().sessionId?.slice(0, 8) || 'n/a'}</p>
        </div>
        <span class={`text-xs px-2 py-0.5 rounded-full ${
          s().kind === 'direct' ? 'bg-accent-blue/20 text-blue-300' : 'bg-accent-purple/20 text-purple-300'
        }`}>
          {s().kind}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-3 text-xs mb-3">
        <div>
          <span class="text-gray-500">Model</span>
          <p class="text-gray-300 font-mono mt-0.5">{s().model || 'n/a'}</p>
        </div>
        <div>
          <span class="text-gray-500">Last Active</span>
          <p class="text-gray-300 mt-0.5">{formatAge(s().ageMs)}</p>
        </div>
        <div>
          <span class="text-gray-500">Tokens</span>
          <p class="text-gray-300 font-mono mt-0.5">{formatTokens(s().totalTokens)}</p>
        </div>
        <div>
          <span class="text-gray-500">Context</span>
          <p class="text-gray-300 font-mono mt-0.5">{formatTokens(s().contextTokens)}</p>
        </div>
      </div>

      <Show when={s().totalTokens && s().contextTokens}>
        <div class="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div class={`h-full ${barColor()} rounded-full transition-all duration-1000`} style={{ width: `${pct()}%` }} />
        </div>
        <p class="text-[10px] text-gray-600 mt-1 text-right">{pct().toFixed(1)}% context used</p>
      </Show>
    </div>
  );
}

function SystemHealth(props: { gateway: GatewayData | undefined }) {
  const g = () => props.gateway;
  return (
    <div class="glass-card p-6 animate-fade-in" style={{ "animation-delay": "100ms" }}>
      <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <span class="text-accent-cyan">⚡</span> System Health
      </h2>
      <Show when={g()} fallback={<p class="text-gray-500 text-sm">Loading...</p>}>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Gateway</span>
            <span class={`text-sm font-medium ${g()!.running ? 'text-emerald-400' : 'text-red-400'}`}>
              {g()!.running ? '● Running' : '○ Stopped'}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Uptime</span>
            <span class="text-sm text-gray-300 font-mono">{g()!.uptime || 'n/a'}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Port</span>
            <span class="text-sm text-gray-300 font-mono">{g()!.config?.port || 'n/a'}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Mode</span>
            <span class="text-sm text-gray-300">{g()!.config?.mode || 'n/a'}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Bind</span>
            <span class="text-sm text-gray-300">{g()!.config?.bind || 'n/a'}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ActivityFeed(props: { sessions: Session[] }) {
  const sorted = () => [...props.sessions].sort((a, b) => a.ageMs - b.ageMs);
  return (
    <div class="glass-card p-6 animate-fade-in" style={{ "animation-delay": "200ms" }}>
      <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <span class="text-accent-purple">📡</span> Activity Feed
      </h2>
      <div class="space-y-3 max-h-64 overflow-y-auto">
        <For each={sorted()}>
          {(s) => (
            <div class="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
              <div class={`w-2 h-2 rounded-full flex-shrink-0 ${s.ageMs < 60000 ? 'bg-emerald-400' : s.ageMs < 300000 ? 'bg-amber-400' : 'bg-gray-600'}`} />
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-300 truncate">{sessionName(s.key)}</p>
                <p class="text-xs text-gray-600">{s.model || 'unknown model'}</p>
              </div>
              <span class="text-xs text-gray-500 flex-shrink-0">{formatAge(s.ageMs)}</span>
            </div>
          )}
        </For>
        <Show when={props.sessions.length === 0}>
          <p class="text-gray-600 text-sm text-center py-4">No recent activity</p>
        </Show>
      </div>
    </div>
  );
}

function ResourceMonitor(props: { sessions: Session[] }) {
  const withTokens = () => props.sessions.filter(s => s.totalTokens && s.contextTokens);
  return (
    <div class="glass-card p-6 animate-fade-in" style={{ "animation-delay": "300ms" }}>
      <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <span class="text-accent-emerald">📊</span> Resource Monitor
      </h2>
      <Show when={withTokens().length > 0} fallback={<p class="text-gray-500 text-sm">No token data available</p>}>
        <div class="flex flex-wrap gap-6 justify-center">
          <For each={withTokens()}>
            {(s) => (
              <GaugeRing
                percent={tokenPercent(s)}
                label={sessionName(s.key)}
                color="#8b5cf6"
              />
            )}
          </For>
        </div>

        <div class="mt-6 space-y-2">
          <For each={withTokens()}>
            {(s) => (
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-400 w-28 truncate">{sessionName(s.key)}</span>
                <div class="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-1000"
                    style={{
                      width: `${tokenPercent(s)}%`,
                      background: `linear-gradient(90deg, #3b82f6, #8b5cf6)`
                    }}
                  />
                </div>
                <span class="text-xs text-gray-500 font-mono w-20 text-right">
                  {formatTokens(s.totalTokens)}/{formatTokens(s.contextTokens)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function StatsBar(props: { sessions: Session[]; gateway: GatewayData | undefined }) {
  const totalSessions = () => props.sessions.length;
  const totalTokens = () => props.sessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  const activeSessions = () => props.sessions.filter(s => s.ageMs < 300000).length;
  const models = () => new Set(props.sessions.map(s => s.model).filter(Boolean)).size;

  const stats = () => [
    { label: 'Sessions', value: totalSessions(), icon: '🔗' },
    { label: 'Active', value: activeSessions(), icon: '🟢' },
    { label: 'Total Tokens', value: formatTokens(totalTokens()), icon: '🪙' },
    { label: 'Models', value: models(), icon: '🧠' },
  ];

  return (
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in">
      <For each={stats()}>
        {(stat) => (
          <div class="glass-card p-4 text-center">
            <div class="text-2xl mb-1">{stat.icon}</div>
            <div class="text-xl font-bold text-white">{stat.value}</div>
            <div class="text-xs text-gray-500 mt-1">{stat.label}</div>
          </div>
        )}
      </For>
    </div>
  );
}

// Main App
export default function App() {
  return (
    <>
      <ToastContainer />
      <Show when={authed()} fallback={<LoginPage />}>
        <Dashboard />
      </Show>
    </>
  );
}

function Dashboard() {
  const [tick, setTick] = createSignal(0);
  const [selectedSession, setSelectedSession] = createSignal<Session | null>(null);
  const [showStaleConfirm, setShowStaleConfirm] = createSignal(false);
  const [cleaningStale, setCleaningStale] = createSignal(false);

  // Auto-refresh every 10s
  const interval = setInterval(() => setTick(t => t + 1), 10000);
  onCleanup(() => clearInterval(interval));

  const [sessionsData, { refetch: refetchSessions }] = createResource(tick, () => fetchJson('/api/sessions') as Promise<SessionsData>);
  const [gatewayData] = createResource(tick, () => fetchJson('/api/gateway') as Promise<GatewayData>);

  const sessions = () => sessionsData()?.sessions || [];

  const handleCleanStale = async () => {
    setCleaningStale(true);
    try {
      const res = await fetch('/api/sessions/stale', { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        const count = data.deleted?.filter((d: any) => d.ok).length || 0;
        addToast(`Cleaned ${count} stale session${count !== 1 ? 's' : ''}`);
        setTick(t => t + 1);
      } else {
        addToast(data.error || 'Cleanup failed', 'error');
      }
    } catch (e: any) {
      addToast(e.message, 'error');
    }
    setCleaningStale(false);
    setShowStaleConfirm(false);
  };

  return (
    <div class="min-h-screen">
      {/* Ambient glow */}
      <div class="fixed inset-0 pointer-events-none overflow-hidden">
        <div class="absolute -top-40 -left-40 w-96 h-96 bg-accent-blue/5 rounded-full blur-3xl" />
        <div class="absolute -bottom-40 -right-40 w-96 h-96 bg-accent-purple/5 rounded-full blur-3xl" />
      </div>

      <div class="relative max-w-7xl mx-auto px-4 pb-12">
        <Header
          gatewayRunning={gatewayData()?.running ?? false}
          onCleanStale={() => setShowStaleConfirm(true)}
          cleaningStale={cleaningStale()}
        />

        <div class="px-4 space-y-6">
          <StatsBar sessions={sessions()} gateway={gatewayData()} />

          {/* Sessions Grid */}
          <div>
            <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <span class="text-accent-blue">💬</span> Sessions
              <span class="text-xs text-gray-600 ml-2">Click a session for details</span>
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <For each={sessions()}>
                {(session, i) => (
                  <SessionCard
                    session={session}
                    index={i()}
                    onClick={() => setSelectedSession(session)}
                  />
                )}
              </For>
            </div>
          </div>

          {/* Bottom Grid */}
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <SystemHealth gateway={gatewayData()} />
            <ActivityFeed sessions={sessions()} />
            <ResourceMonitor sessions={sessions()} />
          </div>
        </div>

        {/* Footer */}
        <footer class="text-center py-8 text-xs text-gray-700">
          OpenClaw Agent Dashboard • Auto-refreshes every 10s • 🦞
        </footer>
      </div>

      {/* Session Detail Panel */}
      <Show when={selectedSession()}>
        <SessionDetailPanel
          session={selectedSession()!}
          onClose={() => setSelectedSession(null)}
          onDeleted={() => { setSelectedSession(null); setTick(t => t + 1); }}
        />
      </Show>

      {/* Stale Cleanup Confirm */}
      <Show when={showStaleConfirm()}>
        <ConfirmDialog
          title="Clean Up Stale Sessions"
          message="This will delete sessions with 99%+ context usage and inactive sub-agents (>1 hour old). Continue?"
          onConfirm={handleCleanStale}
          onCancel={() => setShowStaleConfirm(false)}
          loading={cleaningStale()}
          destructive={true}
        />
      </Show>
    </div>
  );
}
