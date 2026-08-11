// The service worker is a static file in public/ — the bundler copies it
// without ever parsing it, so a syntax error there ships silently and the only
// symptom is that offline stops working. These tests run the real worker source
// against stub browser APIs.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://sharehub.test';

function loadWorker({ networkFails = false, missing = [] } = {}) {
  const listeners = {};
  const stored = new Map();

  const cache = {
    addAll: async (urls) => urls.forEach((url) => stored.set(url, `precached:${url}`)),
    put: async (request, response) => stored.set(keyOf(request), response),
    match: async (request) => stored.get(keyOf(request)),
    keys: async () => [...stored.keys()],
  };

  const context = {
    console,
    URL,
    self: {
      addEventListener: (type, handler) => {
        (listeners[type] ||= []).push(handler);
      },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
      location: { origin: ORIGIN },
    },
    caches: {
      open: async () => cache,
      match: async (request) => stored.get(keyOf(request)),
      keys: async () => ['sharehub-v6', 'sharehub-v1'],
      delete: async () => true,
    },
    fetch: async (request) => {
      if (networkFails) throw new Error('offline');
      const url = keyOf(request);
      if (missing.includes(url)) return { ok: false, status: 404, type: 'basic', text: async () => '' };
      const body = url === '/' || url.endsWith('/')
        ? '<script src="/assets/index-ABC.js"></script><link href="/assets/index-XYZ.css">'
        : url.endsWith('index-ABC.js')
          ? 'new Worker(new URL(`/assets/decode-worker-QQQ.js`, import.meta.url))'
          : 'body';
      const response = { ok: true, type: 'basic', body, text: async () => body };
      response.clone = () => response;
      return response;
    },
    Response: { error: () => 'response-error', redirect: (to) => `redirect:${to}` },
    File: class {},
    indexedDB: {},
  };

  vm.createContext(context);
  new vm.Script(source, { filename: 'sw.js' }).runInContext(context);
  return { listeners, stored };
}

function keyOf(request) {
  return typeof request === 'string' ? request : request.url;
}

/** Drive one fetch event and hand back whatever the worker responded with. */
async function dispatchFetch(listeners, request) {
  let responded;
  const event = {
    request,
    respondWith: (value) => {
      responded = value;
    },
  };
  listeners.fetch[0](event);
  return responded === undefined ? undefined : await responded;
}

describe('service worker', () => {
  let worker;

  beforeEach(() => {
    worker = loadWorker();
  });

  it('parses and registers its lifecycle handlers', () => {
    assert.ok(worker.listeners.install?.length, 'no install handler');
    assert.ok(worker.listeners.activate?.length, 'no activate handler');
    assert.ok(worker.listeners.fetch?.length, 'no fetch handler');
  });

  async function install(target = worker) {
    const waits = [];
    target.listeners.install[0]({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  }

  it('pre-caches the app shell on install', async () => {
    await install();
    assert.ok(worker.stored.has('/'), 'app shell was not pre-cached');
    assert.ok(worker.stored.has('/manifest.json'), 'manifest was not pre-cached');
  });

  it('pre-caches the hashed assets the shell names', async () => {
    await install();
    // Without this the first visit has no offline copy at all: the page's own
    // assets were fetched before the worker existed to intercept them.
    assert.ok(worker.stored.has('/assets/index-ABC.js'), 'main bundle not pre-cached');
    assert.ok(worker.stored.has('/assets/index-XYZ.css'), 'stylesheet not pre-cached');
  });

  it('follows the bundle to the worker chunk it loads', async () => {
    await install();
    // The decode worker is only ever named inside the main bundle, never in the
    // HTML — miss it and catching a transfer offline fails on Safari/Firefox.
    assert.ok(worker.stored.has('/assets/decode-worker-QQQ.js'), 'decode worker not pre-cached');
  });

  it('survives an asset that no longer exists', async () => {
    // One stale URL must not sink the rest of the pre-cache.
    const flaky = loadWorker({ missing: ['/assets/index-XYZ.css'] });
    await assert.doesNotReject(() => install(flaky));

    assert.ok(flaky.stored.has('/'), 'shell lost when an asset 404d');
    assert.ok(flaky.stored.has('/assets/index-ABC.js'), 'sibling asset lost when one 404d');
    assert.equal(flaky.stored.has('/assets/index-XYZ.css'), false, 'cached a 404');
  });

  it('keeps a copy of every hashed asset it fetches', async () => {
    const assetUrl = `${ORIGIN}/assets/index-ABC123.js`;
    await dispatchFetch(worker.listeners, { url: assetUrl, method: 'GET', mode: 'no-cors' });

    assert.ok(worker.stored.has(assetUrl), 'asset was not cached on the way through');
  });

  it('serves a cached asset without touching the network', async () => {
    const assetUrl = `${ORIGIN}/assets/index-ABC123.css`;
    worker.stored.set(assetUrl, 'cached-body');

    const response = await dispatchFetch(worker.listeners, { url: assetUrl, method: 'GET', mode: 'no-cors' });
    assert.equal(response, 'cached-body');
  });

  it('leaves cross-origin requests alone', async () => {
    const response = await dispatchFetch(worker.listeners, {
      url: 'https://fonts.googleapis.com/css2?family=Outfit',
      method: 'GET',
      mode: 'no-cors',
    });
    assert.equal(response, undefined, 'worker should not intercept other origins');
  });

  it('falls back to the cached shell when navigation has no network', async () => {
    const offline = loadWorker({ networkFails: true });
    offline.stored.set('/', 'cached-shell');

    const response = await dispatchFetch(offline.listeners, {
      url: `${ORIGIN}/`,
      method: 'GET',
      mode: 'navigate',
    });
    assert.equal(response, 'cached-shell', 'offline navigation did not fall back to the cache');
  });

  it('still routes the Android share-target POST', async () => {
    const response = await dispatchFetch(worker.listeners, {
      url: `${ORIGIN}/share`,
      method: 'POST',
      mode: 'navigate',
      formData: async () => ({ getAll: () => [] }),
    });
    assert.equal(response, 'redirect:/', 'share target no longer redirects home on an empty post');
  });
});
