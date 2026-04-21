<p align="center">
  <img src="frontend/public/sharehub-logo.svg" alt="ShareHub" width="80" height="80" />
</p>

<h1 align="center">ShareHub</h1>

<p align="center">
  <strong>Peer-to-peer file sharing over your local network. No cloud. No uploads. No limits.</strong>
</p>

<p align="center">
  <a href="https://github.com/iMayuuR/sharehub">View Repository</a> &middot;
  <a href="#getting-started">Getting Started</a> &middot;
  <a href="#architecture">Architecture</a>
</p>

---

## What is ShareHub?

ShareHub is a real-time, cross-platform file transfer tool that runs entirely in your browser. It connects devices on the same Wi-Fi network and streams files directly between them using WebRTC data channels. Your files never touch a server.

Drop a file on one device, receive it on another. That is the entire workflow.

## Key Features

- **Direct P2P Transfer** — Files travel directly between browsers over WebRTC. The signaling server only brokers the initial handshake; it never sees your data.
- **Zero Configuration** — Open the page on two devices connected to the same network. They discover each other automatically.
- **No File Size Limits** — Since transfers are peer-to-peer, there is no server-side storage constraint. Send whatever fits on the receiving device.
- **Progressive Web App** — Install ShareHub to your home screen on Android or desktop. It behaves like a native app with offline support and OS-level share target integration.
- **OS Share Target** — On Android, ShareHub appears in the native share sheet. Select it from any app to beam files directly to a nearby device.
- **QR Code Pairing** — For devices not on the same network, generate a QR code to establish a direct connection via relay.
- **WebSocket Relay Fallback** — When a direct WebRTC connection fails (strict NAT, firewall), the signaling server relays data as a fallback to guarantee delivery.
- **Persistent Identity** — Each device gets a randomly generated name and avatar (e.g., "Cosmic Dolphin 🐬") stored in localStorage. Editable at any time.
- **Drag and Drop** — Drag files directly onto a peer card to initiate a transfer. No file picker required.
- **Responsive Design** — Works on phones, tablets, and desktops. The layout adapts from a single-column mobile view to a multi-column desktop grid.

## Screenshots

> Launch the app on any two devices connected to the same Wi-Fi to see the radar discover peers in real time.

## Architecture

ShareHub is split into two independent services:

```
sharehub/
├── backend/          # Node.js WebSocket signaling server
│   ├── server.js     # Connection brokering, room management, relay fallback
│   └── package.json
│
└── frontend/         # Vite-powered static PWA
    ├── index.html    # Single-page shell with splash screen and modals
    ├── main.js       # Application bootstrap, PWA install logic, service worker registration
    ├── signaling.js  # WebSocket client for peer discovery and signaling
    ├── webrtc.js     # RTCPeerConnection and DataChannel management, chunked file transfer
    ├── identity.js   # Random identity generation and localStorage persistence
    ├── ui.js         # DOM manipulation, peer cards, transfer progress, drag-and-drop
    ├── style.css     # Full design system — dark monochrome theme, animations, responsive layout
    └── public/
        ├── manifest.json       # PWA manifest with share target configuration
        ├── sw.js               # Service worker — asset caching and POST share handler
        └── sharehub-logo.svg   # Application icon
```

### How It Works

1. **Discovery** — When the frontend loads, it opens a WebSocket to the signaling server on port 3000. The server groups clients into rooms based on their source IP. All devices on the same local network land in the same room and immediately see each other.

2. **Signaling** — When a user selects a peer and initiates a file transfer, the frontend creates an `RTCPeerConnection` and exchanges SDP offers/answers and ICE candidates through the WebSocket server.

3. **Data Transfer** — Once the WebRTC data channel opens, the sender slices the file into 64 KB chunks and streams them sequentially. The receiver reassembles the chunks and triggers a download when complete.

4. **Relay Fallback** — If the WebRTC connection cannot be established (symmetric NAT, corporate firewall), the app falls back to relaying file data through the WebSocket server.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- Two devices on the same Wi-Fi network

### 1. Clone the Repository

```bash
git clone https://github.com/iMayuuR/sharehub.git
cd sharehub
```

### 2. Start the Signaling Server

```bash
cd backend
npm install
node server.js
```

The server starts on port `3000` by default. Set the `PORT` environment variable to change it.

### 3. Start the Frontend Dev Server

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite will start on port `5173` and bind to all network interfaces (`--host`). The console output will display the local network URL.

### 4. Open on Two Devices

Open the network URL (e.g., `http://192.168.x.x:5173`) on two devices connected to the same Wi-Fi. They will discover each other within seconds.

## Production Build

```bash
cd frontend
npm run build
```

The output in `dist/` is a fully static site. Serve it with any HTTP server. For production, the signaling server should run behind a reverse proxy with TLS so that WebSocket connections use `wss://` instead of `ws://`.

## Technology Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Frontend   | Vanilla JavaScript, HTML, CSS       |
| Bundler    | Vite 8                              |
| Transport  | WebRTC DataChannel                  |
| Signaling  | WebSocket (ws)                      |
| Backend    | Node.js, Express 5, ws              |
| PWA        | Service Worker, Web App Manifest    |
| Discovery  | IP-based room grouping via server   |

## Browser Support

ShareHub works on any browser with WebRTC DataChannel support:

- Chrome / Edge 80+
- Firefox 75+
- Safari 15+ (including iOS)
- Samsung Internet 12+

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Signaling server port |

The frontend automatically detects the signaling server hostname from `window.location.hostname` and connects on port 3000. No manual configuration is needed for local development.

## Project Principles

1. **No cloud dependency.** Files never leave your local network unless you choose relay mode.
2. **No accounts.** Identity is generated on first visit and stored locally. There is nothing to sign up for.
3. **No frameworks.** The frontend is vanilla JavaScript and CSS. No React, no Angular, no build-time CSS framework. This keeps the bundle small and the runtime fast.
4. **No tracking.** There are no analytics, cookies, or third-party scripts.

## Contributing

Contributions are welcome. Fork the repository, create a feature branch, and open a pull request. Please keep the codebase framework-free and ensure any new UI follows the existing monochrome design language.

## License

This project is open source under the [ISC License](LICENSE).

## Author

**Mayur Patil** — [@iMayuuR](https://github.com/iMayuuR)

Built with [Antigravity](https://github.com/google-deepmind).
