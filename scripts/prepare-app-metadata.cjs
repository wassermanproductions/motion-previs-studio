'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function metadataFor(pkg, builderConfig = null) {
  return {
    name: pkg.name,
    version: pkg.version,
    distribution: builderConfig?.extraMetadata?.distribution || pkg.distribution || null
  };
}

function readBuilderConfig(value) {
  if (!value) return null;
  const file = path.resolve(root, value);
  if (!fs.existsSync(file)) throw new Error(`Electron Builder metadata config does not exist: ${file}`);
  return require(file);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const configValue = process.env.MOTION_PREVIS_BUILDER_CONFIG || process.env.MPS_BUILDER_CONFIG;
  const builderConfig = readBuilderConfig(configValue);
  const out = path.join(root, 'runtime', 'APP_METADATA.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(metadataFor(pkg, builderConfig), null, 2)}\n`);
  console.log(`[metadata] wrote ${path.relative(root, out)}${configValue ? ` using ${configValue}` : ''}`);
}

if (require.main === module) main();

module.exports = { metadataFor, readBuilderConfig };
