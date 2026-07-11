'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
const destination = path.join(root, 'release', 'corresponding-source');

async function main() {
  fs.mkdirSync(destination, { recursive: true });
  const sums = [];
  const platformAssets = process.platform === 'darwin'
    ? manifest.mediaTools.macos.sourceArtifacts
    : manifest.mediaTools.windows.sourceArtifacts;
  const uniqueAssets = [...new Map(platformAssets.map((asset) => [asset.sha256, asset])).values()];
  for (const asset of uniqueAssets) {
    const file = path.join(destination, asset.name);
    if (!matches(file, asset.sha256)) {
      const temp = `${file}.${process.pid}.download`;
      try {
        await download(asset.url, temp, 0);
        if (!matches(temp, asset.sha256)) throw new Error(`SHA-256 mismatch for ${asset.name}`);
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    sums.push(`${asset.sha256}  ${asset.name}`);
    console.log(`[sources] verified ${asset.name}`);
  }
  fs.writeFileSync(path.join(destination, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

function matches(file, expected) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected;
  } catch {
    return false;
  }
}

function download(url, outPath, redirects) {
  if (redirects > 8) return Promise.reject(new Error(`Too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'motion-previs-release/1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, outPath, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(180_000, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });
}

main().catch((error) => {
  console.error(`[sources] ${error.message}`);
  process.exitCode = 1;
});
