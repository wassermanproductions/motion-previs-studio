'use strict';

const path = require('node:path');

function portableBundleFiles(bundleDir, files, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path;
  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => {
      if (!value) return [key, null];
      const relative = p.relative(bundleDir, value);
      if (!relative || relative.startsWith('..') || p.isAbsolute(relative)) {
        throw new Error(`Bundle manifest file "${key}" is outside the production pack.`);
      }
      return [key, relative.split(p.sep).join('/')];
    })
  );
}

function basenameAnyPlatform(filePath, fallback = 'Clip') {
  const parts = String(filePath || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || fallback;
}

module.exports = { portableBundleFiles, basenameAnyPlatform };
