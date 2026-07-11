'use strict';

/**
 * Localhost-only HTTP control server for Motion Previs Studio v4.
 *
 * External agents (MCP clients, Claude Code, Codex, Hermes, …) drive a running
 * copy of the app by POSTing actions here; each action is forwarded to the
 * renderer over IPC ('control:invoke') and its reply ('control:result') is
 * returned as JSON. This mirrors the proven Blockout pattern.
 *
 * Discovery + auth are file-based: on startup we write
 * the platform config directory as control.json (descriptor protocol v1)
 * (mode 0600) and delete it on quit. A client reads that file to learn the
 * random localhost port and bearer token. The server binds 127.0.0.1 only and
 * every /rpc request must carry the bearer token, so it is not reachable
 * off-machine.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.cjs');

const DISCOVERY_FILE = config.motionDiscoveryFile();
const MAX_BODY = 64 * 1024 * 1024; // 64 MB (screenshots/base64 stay well under)

// Per-action timeouts. Long-running pipelines legitimately take minutes.
function timeoutForAction(action) {
  switch (action) {
    case 'run_analysis':
      return 900_000; // 15 min
    case 'export_pack':
      return 900_000; // 15 min
    case 'import_url':
      return 300_000; // 5 min (yt-dlp download)
    case 'import_file':
    case 'screenshot':
      return 120_000;
    default:
      return 30_000;
  }
}

/**
 * @param {() => import('electron').BrowserWindow | null | undefined} getWindow
 * @param {{ ipcMain: import('electron').IpcMain, app: import('electron').App, appName: string, version: string }} deps
 */
async function startControlServer(getWindow, deps) {
  const { ipcMain, app, appName, version } = deps;
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  const discoveryFile = config.motionDiscoveryFile();

  // Registered ONCE — a per-request listener would leak and double-resolve.
  ipcMain.on('control:result', (_event, id, result) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(result);
  });

  function invoke(action, params) {
    const win = getWindow();
    if (!win) return Promise.resolve({ ok: false, error: 'Motion Previs Studio window is not open.' });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout — is the app busy?' });
      }, timeoutForAction(action));
      pending.set(id, { resolve, timer });
      win.webContents.send('control:invoke', id, action, params ?? {});
    });
  }

  // A few actions are handled main-side rather than in the renderer, because
  // they need main-only capabilities (webContents.capturePage). We still route
  // them through the same /rpc surface so the MCP bridge stays uniform.
  async function invokeMainSide(action) {
    if (action === 'screenshot') {
      const win = getWindow();
      if (!win) return { ok: false, error: 'Motion Previs Studio window is not open.' };
      try {
        const image = await win.webContents.capturePage();
        return { ok: true, data: { imageBase64: image.toPNG().toString('base64') } };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }
    return null; // not a main-side action
  }

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(json);
    };

    if (req.method === 'GET' && req.url === '/health') {
      send(200, { ok: true, protocolVersion: 1, app: appName, appVersion: version });
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${token}`) {
        send(401, { ok: false, error: 'unauthorized' });
        return;
      }
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          aborted = true;
          send(413, { ok: false, error: 'request body too large' });
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          send(400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        if (typeof parsed.action !== 'string') {
          send(400, { ok: false, error: 'missing "action"' });
          return;
        }
        const win = getWindow();
        if (!win) {
          send(503, { ok: false, error: 'Motion Previs Studio window is not open.' });
          return;
        }
        void (async () => {
          const mainResult = await invokeMainSide(parsed.action);
          if (mainResult) {
            send(200, mainResult);
            return;
          }
          const result = await invoke(parsed.action, parsed.params);
          if (result && result.error === 'timeout — is the app busy?') {
            send(504, result);
          } else {
            send(200, result);
          }
        })();
      });
      return;
    }

    send(404, { ok: false, error: 'not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
  const descriptor = {
    protocolVersion: 1,
    app: appName,
    appVersion: version,
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    capabilities: ['health', 'rpc', 'screenshot', 'motion-to-blockout-v1']
  };
  fs.writeFileSync(
    discoveryFile,
    JSON.stringify(descriptor, null, 2),
    { mode: 0o600 }
  );

  app.on('will-quit', () => {
    try {
      const current = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
      if (current.token === token) fs.rmSync(discoveryFile, { force: true });
    } catch {
      /* best effort */
    }
  });

  console.log(`[motion-previs] control server on 127.0.0.1:${port}`);
  return { port, token, discoveryFile, descriptor };
}

module.exports = { startControlServer, DISCOVERY_FILE };
