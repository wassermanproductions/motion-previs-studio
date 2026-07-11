'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
const windows = manifest.mediaTools.windows;
if (!['win32', 'darwin'].includes(process.platform)) {
  console.error('[redistribution] Installer publication is blocked: no audited native Linux media assets are configured.');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const recipe = isWindows ? windows : manifest.mediaTools.macos;
const folder = path.join(root, 'runtime', 'media', isWindows ? 'win32-x64' : `darwin-${process.arch}`);
const tools = [
  ['FFmpeg', path.join(folder, isWindows ? 'ffmpeg.exe' : 'ffmpeg')],
  ['FFprobe', path.join(folder, isWindows ? 'ffprobe.exe' : 'ffprobe')]
];
const blockedFlags = recipe.forbiddenConfigureFlags;
const requiredFlags = recipe.requiredConfigureFlags;
let blocked = false;

for (const [name, rawPath] of tools) {
  const binary = typeof rawPath === 'string' ? rawPath : rawPath.path;
  const result = spawnSync(binary, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`[redistribution] ${name} could not be audited: ${result.error?.message || result.stderr}`);
    blocked = true;
    continue;
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const hits = blockedFlags.filter((flag) => output.includes(flag));
  const missing = requiredFlags.filter((flag) => !output.includes(flag));
  if (hits.length || missing.length) {
    if (hits.length) console.error(`[redistribution] BLOCKED: ${name} contains ${hits.join(', ')}.`);
    if (missing.length) console.error(`[redistribution] BLOCKED: ${name} is missing ${missing.join(', ')}.`);
    blocked = true;
  } else {
    console.log(`[redistribution] ${name} configure flags pass the automated nonfree gate.`);
  }
}

if (blocked) {
  console.error('[redistribution] Installer publication is blocked until audited redistributable media binaries replace these assets.');
  process.exit(1);
}
