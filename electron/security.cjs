'use strict';

/**
 * Security helpers for Motion Previs Studio v4.
 *
 * Replaces the old `webSecurity: false` + `file://` media loading with a custom
 * privileged scheme, `mps://`, that serves ONLY files the main process has
 * explicitly allowed:
 *   (a) the app's own workspace roots under app.getPath('userData'), and
 *   (b) user-imported source files/dirs that main recorded at import time.
 *
 * The same allowlist gates shell:open-path / shell:reveal-path.
 */

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SCHEME = 'mps';

// Absolute directory roots that are always allowed (workspace, exports, etc.).
const allowedRoots = new Set();
// Individual absolute file paths that are allowed (specific imported sources).
const allowedFiles = new Set();

function normalizeAbsolute(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    // Resolve to an absolute, normalized path (collapses .. and .).
    return path.resolve(input);
  } catch {
    return null;
  }
}

/** Register a directory root; everything beneath it becomes loadable/openable. */
function allowRoot(dir) {
  const abs = normalizeAbsolute(dir);
  if (abs) allowedRoots.add(abs);
  return abs;
}

/** Register a single file path (and, implicitly, its containing directory root
 *  is NOT added — only the exact file and files that share the recorded dir are
 *  allowed via allowImportSource). */
function allowFile(filePath) {
  const abs = normalizeAbsolute(filePath);
  if (abs) allowedFiles.add(abs);
  return abs;
}

/**
 * Record a user-imported source: allow the exact file, and also allow sibling
 * outputs written next to it is NOT desired — instead we allow the file itself
 * plus its parent directory as a root so associated sidecar files (e.g. a
 * downloaded video + its container dir for yt-dlp imports) resolve. Callers pass
 * `dirAsRoot=true` for import dirs the app itself created.
 */
function allowImportSource(filePath, { dirAsRoot = false } = {}) {
  const abs = allowFile(filePath);
  if (abs && dirAsRoot) allowRoot(path.dirname(abs));
  return abs;
}

function isPathWithinRoot(candidateAbs, rootAbs) {
  if (candidateAbs === rootAbs) return true;
  const rel = path.relative(rootAbs, candidateAbs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True if an absolute path is permitted by the current allowlist. */
function isAllowedPath(input) {
  const abs = normalizeAbsolute(input);
  if (!abs) return false;
  if (allowedFiles.has(abs)) return true;
  for (const root of allowedRoots) {
    if (isPathWithinRoot(abs, root)) return true;
  }
  return false;
}

/** Convert an absolute path to an mps:// URL. */
function toAppUrl(filePath) {
  const abs = normalizeAbsolute(filePath);
  if (!abs) throw new Error('Cannot build media URL for empty path.');
  // Reuse pathToFileURL to get correct percent-encoding, then swap the scheme
  // and move the path into the URL path (host stays empty).
  const fileUrl = pathToFileURL(abs);
  return `${SCHEME}://media${fileUrl.pathname}`;
}

/** Decode an mps:// request URL back to an absolute filesystem path. */
function urlToPath(requestUrl) {
  const parsed = new URL(requestUrl);
  // pathname is percent-encoded and starts with '/'. On Windows the drive letter
  // path is like /C:/... ; decodeURIComponent + normalize handles both.
  let p = decodeURIComponent(parsed.pathname);
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) {
    p = p.slice(1);
  }
  return path.normalize(p);
}

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Register the privileged scheme. MUST be called before app 'ready'.
 * privileged so it behaves like http for media/fetch/CSP purposes.
 */
function registerPrivilegedScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: false
      }
    }
  ]);
}

/**
 * Install the protocol handler. MUST be called after app 'ready'.
 * Serves only allowlisted, existing regular files; everything else 403/404s.
 */
function installProtocolHandler(protocol) {
  protocol.handle(SCHEME, async (request) => {
    let filePath;
    try {
      filePath = urlToPath(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (!isAllowedPath(filePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const type = contentTypeFor(filePath);
    const rangeHeader = request.headers.get('range');
    const total = stat.size;

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` }
          });
        }
        const chunk = fs.createReadStream(filePath, { start, end });
        return new Response(streamToWeb(chunk), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes'
          }
        });
      }
    }

    const stream = fs.createReadStream(filePath);
    return new Response(streamToWeb(stream), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// Convert a Node Readable to a Web ReadableStream (Node >= 17 has the helper).
function streamToWeb(nodeStream) {
  const { Readable } = require('node:stream');
  if (typeof Readable.toWeb === 'function') {
    return Readable.toWeb(nodeStream);
  }
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    }
  });
}

module.exports = {
  SCHEME,
  allowRoot,
  allowFile,
  allowImportSource,
  isAllowedPath,
  toAppUrl,
  urlToPath,
  registerPrivilegedScheme,
  installProtocolHandler
};
