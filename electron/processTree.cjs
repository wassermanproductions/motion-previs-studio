'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 2_000;
const POSIX_GRACE_MS = 1_500;

function childHasClosed(child) {
  return !child || child.exitCode !== null || Boolean(child.signalCode);
}

function waitForChildClose(child) {
  if (childHasClosed(child)) return Promise.resolve(child?.exitCode ?? null);
  return new Promise((resolve) => child.once('close', resolve));
}

function waitForSpawnCompletion(child) {
  if (childHasClosed(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
  });
}

async function waitBounded(promise, timeoutMs) {
  if (timeoutMs <= 0) return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Terminate a child process tree without allowing shutdown/cancellation to hang
 * forever. Returns true only after the tracked child emits close. Callers must
 * not delete temporary output when false is returned because Windows may still
 * hold file handles until the process eventually exits.
 */
async function terminateChildTree(child, closePromise = waitForChildClose(child), options = {}) {
  const platform = options.platform || process.platform;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_TERMINATION_TIMEOUT_MS));
  const spawnProcess = options.spawnProcess || spawn;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  // exitCode/signalCode are set by the earlier `exit` event. File handles and
  // stdio are not guaranteed released until `close`; an explicitly tracked
  // closePromise therefore remains authoritative during cleanup.
  if (childHasClosed(child)) return waitBounded(closePromise, remaining());

  if (platform === 'win32' && child.pid) {
    let killer;
    try {
      killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      const taskkillFinished = await waitBounded(
        waitForSpawnCompletion(killer),
        Math.min(TASKKILL_TIMEOUT_MS, remaining())
      );
      if (!taskkillFinished) {
        try { killer.kill(); } catch { /* best effort */ }
      }
    } catch {
      // Fall through to Node's direct-child termination fallback.
    }

    if (childHasClosed(child)) return waitBounded(closePromise, remaining());
    try { child.kill(); } catch { /* best effort */ }
    return waitBounded(closePromise, remaining());
  }

  try { child.kill('SIGTERM'); } catch { return waitBounded(closePromise, remaining()); }
  if (await waitBounded(closePromise, Math.min(POSIX_GRACE_MS, remaining()))) return true;

  try { child.kill('SIGKILL'); } catch { return waitBounded(closePromise, remaining()); }
  return waitBounded(closePromise, remaining());
}

module.exports = {
  DEFAULT_TERMINATION_TIMEOUT_MS,
  childHasClosed,
  waitForChildClose,
  waitBounded,
  terminateChildTree
};
