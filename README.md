# Agent Dashboard

A real-time monitoring dashboard for [OpenClaw](https://github.com/openclaw/openclaw) AI agents and sub-agents.

Built with **SolidJS** + **Tailwind CSS v4** + **Vite**, with an Express backend that connects to the OpenClaw Gateway via WebSocket.

![Dark mode dashboard](https://img.shields.io/badge/theme-dark_mode-1a1a2e?style=flat-square) ![SolidJS](https://img.shields.io/badge/SolidJS-1.9-2c4f7c?style=flat-square&logo=solid) ![Tailwind](https://img.shields.io/badge/Tailwind-v4-38bdf8?style=flat-square&logo=tailwindcss)

## Features

- **Live Session Monitoring** — View all active agent sessions, sub-agents, and their status in real-time
- **Session Deep Dive** — Click any session to see full details, transcript history, and metadata
- **Session Actions** — Send messages to sessions, delete stale sessions, clean up inactive agents
- **Gateway Health** — Monitor gateway uptime, model info, and connection status
- **Token-Based Auth** — Secured with your OpenClaw gateway token (JWT cookie, 24h expiry)
- **Dark Mode UI** — Modern, aesthetically pleasing interface designed for always-on monitoring

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Gateway token configured (`gateway.auth.mode: "token"`)
- Node.js 18+

## Quick Start

```bash
# Clone the repo
git clone https://github.com/CentauriAgent/agent-dashboard.git
cd agent-dashboard

# Install dependencies
npm install

# Build the frontend
npm run build

# Start the production server
GATEWAY_TOKEN=your_token_here node production-server.cjs
```

The dashboard will be available at `http://localhost:5173`.

## Configuration

The production server connects to the OpenClaw Gateway via WebSocket. Configure with environment variables:

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_TOKEN` | — | **Required.** Your OpenClaw gateway auth token |
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `PORT` | `5173` | Dashboard HTTP port |

## Architecture

```
┌─────────────┐     HTTP      ┌──────────────────┐     WebSocket     ┌─────────────────┐
│   Browser    │◄────────────►│  Express Server   │◄────────────────►│ OpenClaw Gateway │
│  (SolidJS)   │              │ (production-      │                  │   (port 18789)   │
│              │              │  server.cjs)      │                  │                  │
└─────────────┘              └──────────────────┘                  └─────────────────┘
```

- **Frontend** (`src/App.tsx`): SolidJS reactive UI with Tailwind v4 styling
- **Backend** (`production-server.cjs`): Express server that proxies requests to the OpenClaw Gateway WebSocket, handles auth (JWT cookies), and serves the built frontend

## Development

```bash
# Run the Vite dev server (frontend hot reload)
npm run dev

# In another terminal, run the backend
GATEWAY_TOKEN=your_token_here node production-server.cjs
```

## Running as a Service (systemd)

```bash
# Create user service
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/agent-dashboard.service << 'EOF'
[Unit]
Description=Agent Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/agent-dashboard
ExecStart=/usr/bin/node production-server.cjs
Environment=GATEWAY_TOKEN=your_token_here
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now agent-dashboard
loginctl enable-linger $USER
```

## Gateway WebSocket Methods Used

The dashboard communicates with OpenClaw using these Gateway WS methods:

- `sessions.list` — Fetch all active sessions
- `chat.history` — Get transcript for a specific session
- `chat.send` — Send a message to a session
- `sessions.delete` — Remove a session
- `sessions.compact` — Compact session history

## Tech Stack

- **[SolidJS](https://www.solidjs.com/)** — Reactive UI framework
- **[Tailwind CSS v4](https://tailwindcss.com/)** — Utility-first styling
- **[Vite](https://vite.dev/)** — Build tool and dev server
- **[Express](https://expressjs.com/)** — Production HTTP server
- **[ws](https://github.com/websockets/ws)** — WebSocket client for Gateway communication

## License

MIT

## Credits

Built by [Centauri](https://github.com/CentauriAgent) ⭐ — an AI agent running on OpenClaw, created by [Derek Ross](https://github.com/derekross).
