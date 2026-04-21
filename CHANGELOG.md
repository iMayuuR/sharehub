# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0] — 2026-04-21

### Added

- **Core P2P File Transfer** — WebRTC DataChannel-based file streaming with 64 KB chunked transfer. Supports files of any size with real-time progress tracking.
- **Automatic Peer Discovery** — Devices on the same local network are grouped into rooms by the signaling server based on source IP address. No manual pairing required.
- **WebSocket Signaling Server** — Lightweight Node.js server handling SDP offer/answer exchange, ICE candidate relay, and room-based peer management.
- **WebSocket Relay Fallback** — When direct peer-to-peer connections fail due to strict NAT or firewall restrictions, data is relayed through the signaling server to guarantee delivery.
- **Progressive Web App** — Full PWA support with service worker for offline caching, web app manifest, and home screen installation. The app runs in standalone mode once installed.
- **OS Share Target** — Android share sheet integration. ShareHub registers as a share target in the manifest, allowing users to send files from any app directly into ShareHub via the service worker's POST handler.
- **QR Code Pairing** — Manual pairing via QR code for devices not on the same local network. Scanning the code connects both peers through a shared room on the signaling server.
- **Smart PWA Install Bubble** — Custom floating install prompt that detects whether the app is already installed, shows platform-specific instructions for iOS, and uses the native `beforeinstallprompt` event on Android and desktop.
- **Persistent Device Identity** — Random identity generation on first visit (adjective + animal + emoji). Stored in localStorage and editable via the profile modal. Identity syncs across sessions.
- **Drag and Drop** — Files can be dropped directly onto a peer card to initiate transfer. Also supports the standard file picker via click.
- **Real-Time Transfer Progress** — Per-file progress bars with percentage, transfer speed display, and automatic download trigger on completion.
- **FOUC Prevention** — Splash screen with loading spinner that holds until CSS custom properties and web fonts are fully loaded, preventing any layout flash.
- **Responsive Layout** — Single-column layout on mobile, two-column on tablet, auto-fill grid on desktop. Header adapts by hiding the username on narrow viewports.
- **Monochrome Dark Theme** — High-contrast black and white design system with consistent use of `#000000` backgrounds, `#ffffff` text, and `#222222` borders. No accent colors.
- **Animated Radar UI** — Discovery section features a pulsing radar animation with floating dots while scanning for peers. Active state indicated by a breathing white dot.
- **Footer** — Persistent footer pinned to viewport bottom with dynamic copyright year, author attribution, and a styled GitHub repository link.

### Technical Details

- **Frontend** — Vanilla JavaScript (ES modules), CSS, HTML. Bundled with Vite 8. No runtime framework.
- **Backend** — Node.js with Express 5 and the `ws` WebSocket library. Single `server.js` file.
- **Service Worker** — Caches core assets on install. Intercepts POST requests to `/share` for OS share target, storing shared files in IndexedDB for retrieval by the main app.
- **WebRTC Configuration** — Uses Google's public STUN server (`stun:stun.l.google.com:19302`) for NAT traversal.
- **Room Logic** — Server normalizes IPv4-mapped IPv6 addresses and groups all private network IPs (`192.168.*`, `10.*`, `172.*`, loopback) into a single `local-lan` room.

---

*For older history, see the [git log](https://github.com/iMayuuR/sharehub/commits/main).*
