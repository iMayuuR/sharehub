# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.2.0] — 2026-08-11

### Added

- **PhotonHub** — Move files between two devices with no network at all. One screen shows them as an endless stream of animated QR codes, the other films it and rebuilds them. Two modes: **Beam** (send) and **Catch** (receive).
- **Radar / Photon Tabs** — The home screen now switches between the networked path and the optical one. Losing the network moves the app to PhotonHub by itself; tapping a tab pins the choice for the session, so nobody gets dragged between screens mid-task. An offline banner explains what happened.
- **Multi-File PhotonHub** — Pick several files and they travel as one bundled stream: a manifest plus the file bodies, fountain-coded together and unpacked back into separate downloads at the far end. The manifest rides inside the payload, because a meta frame has to fit in a single QR code.
- **Fountain-Coded Frames** — The sender never stops and never waits for an acknowledgement, because a screen-to-camera link has no back-channel. Frames are Luby-transform symbols over the payload's blocks, so the receiver can join at any moment, in any order, and dropped frames cost time instead of correctness. The first pass is systematic, so catching the start of a stream finishes in exactly one pass.
- **Base45 Frames in QR Alphanumeric Mode** — Costs ~3% of payload capacity and makes every frame survive a string-only decoder, which is what lets the native `BarcodeDetector` fast path work at all. jsQR runs in a Web Worker wherever `BarcodeDetector` is missing (Safari, Firefox).
- **Metadata and Verification** — Filename, media type and a SHA-256 of the payload ride in their own frame type, mixed into the stream at most every 16th frame and more often for short files. Payloads are gzipped only when that actually shrinks them, and the hash is checked before any download is offered.
- **Beam Controls** — Frame rate (4–24 fps) and code density (four presets from Safe to Max) are adjustable mid-transfer and remembered between sessions. The header shows the estimated time per full pass.
- **Real Offline Support** — The service worker now keeps a copy of every asset it fetches, so the second visit owns a complete offline copy of the app. Previously only `/` and the manifest were cached and offline depended entirely on the browser's HTTP cache holding.
- **Screen Wake Lock** — Both ends hold a wake lock for the duration; a display that sleeps stops transmitting or stops filming.
- **`npm run dev:https`** — Self-signed dev server. `getUserMedia` is refused outside a secure context, so catching over LAN needs https; plain `npm run dev` is unchanged.

### Fixed

- **Any File Over 256 KB Failed to Send, Silently** — SCTP negotiates a maximum message size and refuses anything larger; Chrome advertises 256 KB. The sender used a fixed 4 MB chunk, so the very first chunk of any larger file was rejected — and the rejection was mistaken for back-pressure, so it waited on a drain event that could never arrive. The transfer hung at 0% and, because the file sat at the head of the queue, took every file behind it down too. Chunks are now cut to whatever the peer actually negotiated. This was almost certainly the iOS failure as well, since Safari advertises a smaller ceiling still.
- **Every Transfer Threw on Completion** — The ack handler drained the relay queue, but that map was only created when a relay transfer started, so a direct transfer hit `undefined` on every completed file. Both queues are now built up front.
- **Links Were Throttled to an Eighth of Their Speed** — The receiver reported throughput in megabytes but the flow controller compared it against megabit thresholds, so a healthy 23 Mbps Wi-Fi link reported "2.9" and tripped the "slow mobile link" branch, halving the in-flight window on every file.
- **Devices Appeared, Vanished and Came Back** — A departure was announced the moment a socket closed, so a phone backgrounding for a second, or a Wi-Fi blip, cleared it from everyone's radar until it reconnected. Departures now wait out a grace period and are dropped entirely if the device returns; a reconnect no longer re-announces a device that never appeared to leave.
- **Discovery Depended on One Externally-Fetched Address** — Peers were grouped by a public IP the browser looked up from a third-party API, held only in memory. A reload re-asked, a different provider could answer differently, and the device silently moved to another room. The address is now persisted, and peers join rooms for both the address they report and the one the server observes, so a blocked lookup no longer isolates a device.
- **Sharing From the Gallery Went Nowhere Visible** — The handover message was written into the radar's empty state, which lives inside the Radar tab: a user on PhotonHub saw nothing at all after sharing, and the radar's own markup was overwritten for good. Shared files now land in a tray above the tabs, visible in either mode, with a one-tap beam.
- **A VPN Made Discovery Fail Without Explanation** — Two devices on the same Wi-Fi leave by different routes when one is on a VPN, and nothing on the network can group them. The server now spots the mismatch and the radar says so, pointing at a Room Code instead of spinning forever.
- **PhotonHub Renamed Long Filenames** — Names had to fit in a meta frame, which meant truncating them. The payload is always a bundle now, so the manifest carries the exact name however long it is; the meta frame's copy is display-only.
- **Multi-File Send Stalled After the First File** — Queued files after the first never left the sender. On finishing a file the queue waited for `bufferedamountlow`, but that event only fires when the buffer *crosses down* through the threshold; a buffer already below the mark meant waiting for an event that would never arrive. Sending three files delivered exactly one. The queue now advances immediately when there is nothing to drain, with a timer behind it for a congested channel.
- **PhotonHub Panel Text Collided With the Tiles** — The note under Beam/Catch was pulled up by a negative margin and sat on top of them.
- **Pair Modal Overflowed Narrow Screens** — The room-code input refused to shrink and pushed the Join button off the right edge below ~370px. Its inline styles are now real CSS that can shrink.
- **QR Version 23 at Low ECC** — Codes at this one version/level pair are written with a block layout readers do not agree on, and nothing could read them back. Frames that would land there now step up a version.

### Improved

- **The Beamed Code No Longer Twitches** — Its size came from `window.innerHeight`, which on a phone changes by ~60px every time the URL bar slides in or out. Scrolling down to reach the controls was itself what made the code jump between two sizes. The stage no longer scrolls at all: the code takes whatever height the controls do not need, measured from its own container, and small changes are ignored outright.
- **Beam and Catch Controls Stay On Screen** — They used to sit below the fold on a short screen, which is exactly where a hand holding a phone cannot reach them.
- **Modern Mode Tabs** — Drawn icons instead of emoji, with a proper active state.
- **Responsive Down to 350px** — Every screen, including the fullscreen Beam and Catch stages, is verified free of horizontal overflow from 350px upward.
- **Service Worker Failures Are Visible** — Registration errors were swallowed silently, which hid a broken worker behind "offline just does not work". `public/sw.js` is also copied to the build without ever being parsed by the bundler, so `npm test` now parses and exercises it.
- **Service Worker v6** — Cache bumped so the new assets and caching strategy are picked up on update. Install reads the shell for its content-hashed asset URLs, and those bundles for the chunks they load in turn, so the very first visit owns a complete offline copy instead of waiting for a second one.

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
