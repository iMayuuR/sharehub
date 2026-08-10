// wake-lock.js — keep the screen on for the duration of an optical transfer.
//
// Both ends need this: a sender whose display sleeps stops transmitting, and a
// receiver whose display sleeps stops filming. The lock is dropped by the
// browser whenever the tab is hidden, so it has to be re-taken on the way back.

export function createWakeLock() {
  let sentinel = null;
  let wanted = false;

  async function acquire() {
    if (!navigator.wakeLock || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      // Denied, unsupported, or the page was already hidden — the transfer
      // still works, the user just has to keep the screen awake themselves.
    }
  }

  function onVisibility() {
    if (wanted && document.visibilityState === 'visible') acquire();
  }

  return {
    start() {
      if (wanted) return;
      wanted = true;
      document.addEventListener('visibilitychange', onVisibility);
      acquire();
    },
    stop() {
      wanted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        sentinel.release().catch(() => {});
        sentinel = null;
      }
    },
  };
}
