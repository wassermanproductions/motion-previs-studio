'use strict';

/**
 * Install a one-shot asynchronous quit gate.
 *
 * Electron does not await async event listeners. The first before-quit event
 * is therefore cancelled explicitly while cleanup runs. Once every cleanup
 * task settles, app.quit() is issued again and the second event is allowed
 * through. Repeated quit requests while cleanup is in flight cannot start a
 * second cleanup pass.
 */
function installShutdownGate(app, cleanup, { logError = console.error } = {}) {
  let state = 'idle';
  let cleanupPromise = null;

  app.on('before-quit', (event) => {
    if (state === 'ready') return;

    event.preventDefault();
    if (state === 'cleaning') return;

    state = 'cleaning';
    let cleanupResult;
    try {
      // Invoke synchronously so cleanup can close the admission gates for new
      // work before this before-quit callback returns to Electron.
      cleanupResult = cleanup();
    } catch (error) {
      cleanupResult = Promise.reject(error);
    }
    cleanupPromise = Promise.resolve(cleanupResult)
      .catch((error) => {
        logError(`[motion-previs] shutdown cleanup failed: ${error?.message || error}`);
      })
      .finally(() => {
        state = 'ready';
        app.quit();
      });
  });

  return {
    get state() {
      return state;
    },
    get cleanupPromise() {
      return cleanupPromise;
    }
  };
}

module.exports = { installShutdownGate };
