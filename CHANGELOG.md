# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.2.0] — 2026-08-11

### Added

- **Lightwave** — Move files between two devices with no network at all. One screen shows them as an endless stream of animated QR codes, the other films it and rebuilds them. Two modes: **Beam** (send) and **Catch** (receive).
- **Radar / Lightwave Tabs** — The home screen now switches between the networked path and the optical one. Losing the network moves the app to Lightwave by itself; tapping a tab pins the choice for the session, so nobody gets dragged between screens mid-task. An offline banner explains what happened.
- **Multi-File Lightwave** — Pick several files and they travel as one bundled stream: a manifest plus the file bodies, fountain-coded together and unpacked back into separate downloads at the far end. The manifest rides inside the payload, because a meta frame has to fit in a single QR code.
- **Fountain-Coded Frames** — The sender never stops and never waits for an acknowledgement, because a screen-to-camera link has no back-channel. Frames are Luby-transform symbols over the payload's blocks, so the receiver can join at any moment, in any order, and dropped frames cost time instead of correctness. The first pass is systematic, so catching the start of a stream finishes in exactly one pass.
- **Base45 Frames in QR Alphanumeric Mode** — Costs ~3% of payload capacity and makes every frame survive a string-only decoder, which is what lets the native `BarcodeDetector` fast path work at all. jsQR runs in a Web Worker wherever `BarcodeDetector` is missing (Safari, Firefox).
- **Metadata and Verification** — Filename, media type and a SHA-256 of the payload ride in their own frame type, mixed into the stream at most every 16th frame and more often for short files. Payloads are gzipped only when that actually shrinks them, and the hash is checked before any download is offered.
- **Beam Controls** — Frame rate (4–24 fps) and code density (four presets from Safe to Max) are adjustable mid-transfer and remembered between sessions. The header shows the estimated time per full pass.
- **Real Offline Support** — The service worker now keeps a copy of every asset it fetches, so the second visit owns a complete offline copy of the app. Previously only `/` and the manifest were cached and offline depended entirely on the browser's HTTP cache holding.
- **Screen Wake Lock** — Both ends hold a wake lock for the duration; a display that sleeps stops transmitting or stops filming.
- **`npm run dev:https`** — Self-signed dev server. `getUserMedia` is refused outside a secure context, so catching over LAN needs https; plain `npm run dev` is unchanged.

### Fixed

- **Multi-File Send Stalled After the First File** — Queued files after the first never left the sender. On finishing a file the queue waited for `bufferedamountlow`, but that event only fires when the buffer *crosses down* through the threshold; a buffer already below the mark meant waiting for an event that would never arrive. Sending three files delivered exactly one. The queue now advances immediately when there is nothing to drain, with a timer behind it for a congested channel.
- **Pair Modal Overflowed Narrow Screens** — The room-code input refused to shrink and pushed the Join button off the right edge below ~370px. Its inline styles are now real CSS that can shrink.
- **QR Version 23 at Low ECC** — Codes at this one version/level pair are written with a block layout readers do not agree on, and nothing could read them back. Frames that would land there now step up a version.

### Improved

- **Responsive Down to 350px** — Every screen, including the fullscreen Beam and Catch stages, is verified free of horizontal overflow from 350px upward.
- **Service Worker Failures Are Visible** — Registration errors were swallowed silently, which hid a broken worker behind "offline just does not work". `public/sw.js` is also copied to the build without ever being parsed by the bundler, so `npm test` now parses and exercises it.
- **Service Worker v6** — Cache bumped so the new assets and caching strategy are picked up on update.

---

## [1.1.0] — 2026-04-22

### Fixed
- **99% Stuck Transfer** — Forced progress to 100% on both sender and receiver upon file completion to prevent UI stall due to floating-point rounding.
- **ACK Synchronization** — Implemented triple-redundant acknowledgment (Data Channel + Signaling Fallback + 8s Timeout) to ensure sender always marks transfer as complete.
- **CSS 404 (Stale Assets)** — Bumped Service Worker to v4 and removed hashed asset pre-caching to prevent 404 errors on site updates.
- **Mobile UI Overlap** — Fixed active transfer sheet covering the footer. Added dynamic padding-bottom management.
- **Console Cleanup** — Removed all production console logs and debug statements for a clean developer console.

### Improved
- **Local Discovery** — Forced IPv4 fetching and implemented IPv4-mapped IPv6 normalization on the server for more reliable same-network peer grouping.
- **Mobile UX** — Disabled text selection on interactive elements to prevent ugly blue highlighting on touch. Increased mobile cancel button size to 36px for better touch targets.
- **Room Persistence** — Implemented "Auto-Join Last Room" memory. If you pair with a Room Code once, ShareHub remembers it and automatically joins it on next visit for a seamless AirDrop-like experience.

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
