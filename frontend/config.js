// config.js — the one place the signaling server's address is written down.
//
// It used to be spelled out separately in signaling.js and in main.js, and when
// the Render service came up under a different hostname both copies were left
// pointing at a name that answers 404. Radar cannot find anybody without this
// address, so it lives here and nowhere else.
//
// `VITE_SIGNALING_URL` overrides it at build time for self-hosting.

const DEFAULT_SIGNALING_ORIGIN = 'https://sharehub-c240.onrender.com';

/** Local dev runs the server from backend/ on port 3002. */
export function isLocalHost() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

/** https:// origin, for health pings and plain fetches. */
export function signalingOrigin() {
  const configured = import.meta.env.VITE_SIGNALING_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return isLocalHost() ? `http://${window.location.hostname}:3002` : DEFAULT_SIGNALING_ORIGIN;
}

/** ws:// or wss:// base for the signaling socket. */
export function signalingSocketBase() {
  return signalingOrigin().replace(/^http/, 'ws');
}
