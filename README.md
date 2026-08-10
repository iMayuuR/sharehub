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
- **Lightwave (no network at all)** — Send files with no Wi-Fi, no server and no pairing. One device shows them as an endless stream of animated QR codes; the other films it with its camera and rebuilds them. Fountain-coded, so dropped frames only cost time. See [Lightwave](#lightwave--transfer-with-no-network).
- **Automatic Offline Fallback** — Lose the network and ShareHub switches itself to Lightwave, because a radar that will never find anything is not worth staring at. The app itself keeps working offline: the service worker holds a complete copy.
- **QR Code Pairing** — For devices not on the same network, generate a QR code to establish a direct connection via relay.
- **WebSocket Relay Fallback** — When a direct WebRTC connection fails (strict NAT, firewall), the signaling server relays data as a fallback to guarantee delivery.
- **Persistent Identity** — Each device gets a randomly generated name and avatar (e.g., "Cosmic Dolphin 🐬") stored in localStorage. Editable at any time.
- **Drag and Drop** — Drag files directly onto a peer card to initiate a transfer. No file picker required.
- **Responsive Design** — Works on phones, tablets, and desktops. The layout adapts from a single-column mobile view to a multi-column desktop grid.
- **Room Persistence** — ShareHub remembers the last manually joined Room Code and automatically reconnects on next visit, making pairing a one-time setup for private networks.

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
    ├── mode-switch.js # Radar / Lightwave tabs and the offline fallback
    ├── optical/      # Lightwave: screen-to-camera transfer (no network involved)
    │   ├── protocol.js      # Frame wire format, gzip, SHA-256
    │   ├── bundle.js        # Several files as one payload
    │   ├── fountain.js      # Luby transform encoder and peeling decoder
    │   ├── base45.js        # RFC 9285 — keeps frames inside QR alphanumeric mode
    │   ├── qr-render.js     # QR generation and pixel-exact canvas painting
    │   ├── sender.js        # Beam: the animated QR loop
    │   ├── receiver.js      # Catch: camera capture and decode
    │   ├── decode-worker.js # jsQR fallback decoder, off the main thread
    │   └── ui.js            # Beam/Catch screens
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

## Lightwave — transfer with no network

Everything above still needs *a* network. Lightwave needs none: it moves files
from one screen into another device's camera. Air-gapped machine, hotel Wi-Fi
that blocks peer traffic, guest network, aeroplane — the payload travels as
light.

The home screen has two tabs. **Radar** is everything above; **Lightwave** is
this. Lose the network and the app moves to Lightwave on its own — tapping a tab
yourself pins the choice for the rest of the session, because being dragged
between screens mid-task is worse than a stale tab.

- **Beam** — choose one file or several. The device fills its screen with an
  animated QR code that never stops looping.
- **Catch** — point the other device's camera at that screen. Progress climbs as
  frames land; files download and verify themselves when it completes.

Pick several files and they travel as a single stream: a manifest plus the file
bodies, concatenated and fountain-coded as one payload, unpacked back into
separate downloads at the far end. The manifest rides *inside* the payload
rather than in a meta frame, because a meta frame has to fit in one QR code and
a list of forty filenames does not.

### How it works

A screen-to-camera link has no back-channel. The sender cannot know which frames
the camera missed, and the receiver may start filming halfway through. So the
sender does not send the file once — it emits an endless stream of
[fountain-coded](https://en.wikipedia.org/wiki/Luby_transform_code) frames, each
the XOR of a pseudo-random subset of the file's blocks. The receiver collects any
distinct frames, in any order, and peels the file back out once it has enough.
**Dropped frames cost time, never correctness.**

The first pass is systematic (frame *i* carries block *i*), so a receiver that
catches the very start finishes in exactly *K* frames. Everything after that is
soliton-distributed and converges at roughly 1.1–1.2 × *K*.

Each frame is Base45-encoded so it rides in QR *alphanumeric* mode. That costs
about 3% of the payload capacity and buys back something worth far more: every QR
reader — including the browser's native `BarcodeDetector`, which only ever returns
a string — hands the frame back byte-exact. Where `BarcodeDetector` is missing
(Safari, Firefox), jsQR runs in a worker instead.

Metadata (name, type, SHA-256) rides in its own frame type, mixed into the
stream at most every 16th frame and more often for short files — a small payload
finishes inside the systematic prefix, so a fixed cadence would let the last
block beat the filename home. The payload is gzipped only when that actually
shrinks it, and the hash is checked before anything is offered for download.

Frames reach the decoder at the camera's own resolution and are never rescaled.
Resampling interpolates across module edges, and a dense code whose modules are
a few pixels wide stops decoding entirely once they blur together.

### What to expect

| | |
|---|---|
| Speed | roughly 5–40 KB/s, depending on screen size, density and camera |
| Best for | documents, photos, keys, config files, short clips |
| Size limit | 32 MB total, across however many files you picked |
| Multiple files | Yes — they travel as one bundled stream |
| Encryption | none — anything on the sending screen is readable by any camera pointed at it |

Density and frame rate are adjustable while beaming. Bigger, faster codes move
more per second but demand a closer, steadier camera; drop to **Safe** if the
receiver is struggling.

### Working offline

The service worker keeps a copy of every asset it fetches, so the second visit
owns a complete offline copy of the app and Lightwave works with the radio off.
Asset filenames are content-hashed by the bundler, so they cannot be listed for
pre-caching ahead of time — guessing them is what produced stale 404s in the
past — and they are cached on the way through instead.

Note that `public/sw.js` is copied to the build verbatim and never parsed by the
bundler, so a syntax error in it ships silently and the only symptom is that
offline stops working. `npm test` parses and exercises it for exactly that
reason.

### Camera access needs https

`getUserMedia` is refused outside a secure context, so a phone opening
`http://192.168.x.x:5173` can never open its camera. For local development:

```bash
cd frontend
npm run dev:https
```

Accept the self-signed certificate once on each device. Beaming works fine over
plain http — only the catching side needs the secure origin. In production the
site is served over https already.

Prior art worth reading: [divan/txqr](https://github.com/divan/txqr),
[sz3/libcimbar](https://github.com/sz3/libcimbar), and
[decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer),
which is where the idea for this feature came from.

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

## Tests

```bash
cd frontend
npm test
```

Covers the transfer queue, the service worker, and the Lightwave codec: Base45
round-trips, the wire format, fountain coding under frame loss, multi-file
bundles, and a full loop where the real sender paints QR frames, jsQR reads
those pixels back the way a camera would, and the real receiver reassembles the
files.

## Technology Stack

| Layer      | Technology                                             |
|------------|--------------------------------------------------------|
| Frontend   | Vanilla JavaScript, HTML, CSS                          |
| Bundler    | Vite 8                                                 |
| Transport  | WebRTC DataChannel                                     |
| Signaling  | WebSocket (ws)                                         |
| Backend    | Node.js, Express 5, ws                                 |
| PWA        | Service Worker, Web App Manifest                       |
| Discovery  | IP-based room grouping via server                      |
| Optical    | LT fountain codes, Base45, qrcode-generator, jsQR       |

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
