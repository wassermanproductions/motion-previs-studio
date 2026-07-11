'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const components = externalComponents();

const cdxPath = path.join(release, 'sbom.cdx.json');
const cdx = JSON.parse(stripBom(fs.readFileSync(cdxPath, 'utf8')));
cdx.components = [...(cdx.components || []), ...components.map(toCycloneDx)];
const cdxRootRef = cdx.metadata?.component?.['bom-ref'];
if (cdxRootRef) {
  cdx.dependencies = cdx.dependencies || [];
  let rootDependency = cdx.dependencies.find((entry) => entry.ref === cdxRootRef);
  if (!rootDependency) {
    rootDependency = { ref: cdxRootRef, dependsOn: [] };
    cdx.dependencies.push(rootDependency);
  }
  rootDependency.dependsOn = [...new Set([
    ...(rootDependency.dependsOn || []),
    ...components.map((component) => component.id)
  ])];
}
fs.writeFileSync(cdxPath, `${JSON.stringify(cdx, null, 2)}\n`);

const spdxPath = path.join(release, 'sbom.spdx.json');
const spdx = JSON.parse(stripBom(fs.readFileSync(spdxPath, 'utf8')));
spdx.packages = [...(spdx.packages || []), ...components.map(toSpdx)];
const appPackage = spdx.packages.find((entry) => entry.name === lock.name);
spdx.relationships = [
  ...(spdx.relationships || []),
  ...components.map((component) => ({
    spdxElementId: appPackage?.SPDXID || 'SPDXRef-DOCUMENT',
    relationshipType: appPackage ? (component.scope === 'optional' ? 'DEPENDS_ON' : 'CONTAINS') : 'DESCRIBES',
    relatedSpdxElement: spdxId(component.id)
  }))
];
fs.writeFileSync(spdxPath, `${JSON.stringify(spdx, null, 2)}\n`);
console.log(`[sbom] added ${components.length} external/runtime components to CycloneDX and SPDX SBOMs`);

function externalComponents() {
  const result = [];
  // Vite and electron-builder consume these development-time packages to
  // create files/binaries that are shipped at runtime. npm's generated SBOM
  // only sees production Node dependencies, so record the bundled runtime
  // components explicitly from the lockfile.
  for (const name of [
    'electron',
    'react',
    'react-dom',
    'three',
    'lucide-react',
    '@huggingface/transformers',
    '@mediapipe/tasks-vision'
  ]) {
    const metadata = lock.packages?.[`node_modules/${name}`];
    if (!metadata?.version) throw new Error(`Missing bundled runtime package ${name} in package-lock.json`);
    result.push({
      id: `bundled-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      version: metadata.version,
      license: metadata.license || 'NOASSERTION',
      url: metadata.resolved || `https://www.npmjs.com/package/${name}/v/${metadata.version}`,
      hash: null,
      scope: 'required',
      type: name === 'electron' ? 'application' : 'library',
      properties: [{ name: 'motion-previs:delivery', value: 'bundled-runtime' }]
    });
  }

  const yt = manifest.ytDlp.targets[process.platform] || manifest.ytDlp.targets.linux;
  result.push(component('yt-dlp', manifest.ytDlp.version, manifest.ytDlp.license, yt.url, path.join(root, 'runtime', 'bin', yt.name), yt.sha256));

  for (const model of manifest.poseModels) {
    result.push(component(model.name, '1', model.license, model.url, path.join(root, 'public', 'models', model.name), model.sha256, 'file'));
  }
  for (const name of manifest.mediapipe.requiredWasmFiles) {
    result.push(component(
      `MediaPipe ${name}`,
      manifest.mediapipe.version,
      manifest.mediapipe.license,
      'https://www.npmjs.com/package/@mediapipe/tasks-vision',
      path.join(root, 'public', 'mediapipe', 'wasm', name),
      null,
      'file'
    ));
  }

  if (process.platform === 'win32') {
    const dir = path.join(root, 'runtime', 'media', 'win32-x64');
    result.push(component('FFmpeg', manifest.mediaTools.windows.releaseTag, manifest.mediaTools.windows.license, manifest.mediaTools.windows.archiveUrl, path.join(dir, 'ffmpeg.exe'), manifest.mediaTools.windows.ffmpegSha256));
    result.push(component('FFprobe', manifest.mediaTools.windows.releaseTag, manifest.mediaTools.windows.license, manifest.mediaTools.windows.archiveUrl, path.join(dir, 'ffprobe.exe'), manifest.mediaTools.windows.ffprobeSha256));
  } else if (process.platform === 'darwin') {
    const dir = path.join(root, 'runtime', 'media', `darwin-${process.arch}`);
    result.push(component('FFmpeg', manifest.mediaTools.macos.ffmpegCommit, manifest.mediaTools.macos.license, manifest.mediaTools.macos.buildArchiveUrl, path.join(dir, 'ffmpeg')));
    result.push(component('FFprobe', manifest.mediaTools.macos.ffmpegCommit, manifest.mediaTools.macos.license, manifest.mediaTools.macos.buildArchiveUrl, path.join(dir, 'ffprobe')));
  }

  result.push({
    id: 'depth-anything-first-use',
    name: manifest.depthAnything.repository,
    version: manifest.depthAnything.revision,
    license: 'Apache-2.0',
    url: `https://huggingface.co/${manifest.depthAnything.repository}/tree/${manifest.depthAnything.revision}`,
    scope: 'optional',
    type: 'machine-learning-model',
    properties: [{ name: 'motion-previs:delivery', value: manifest.depthAnything.delivery }]
  });
  return result;
}

function component(name, version, license, url, file, expectedHash, type = 'application') {
  const actualHash = fs.existsSync(file) ? sha256(file) : expectedHash;
  if (expectedHash && actualHash !== expectedHash) throw new Error(`SBOM hash mismatch for ${name}`);
  return {
    id: `external-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    version,
    license,
    url,
    hash: actualHash,
    scope: 'required',
    type,
    properties: []
  };
}

function toCycloneDx(component) {
  return {
    type: component.type === 'machine-learning-model' ? 'machine-learning-model' : component.type,
    'bom-ref': component.id,
    name: component.name,
    version: component.version,
    scope: component.scope,
    ...(component.hash ? { hashes: [{ alg: 'SHA-256', content: component.hash }] } : {}),
    licenses: [{ license: { id: spdxLicense(component.license) } }],
    externalReferences: [{ type: 'distribution', url: component.url }],
    properties: component.properties
  };
}

function toSpdx(component) {
  return {
    name: component.name,
    SPDXID: spdxId(component.id),
    versionInfo: component.version,
    downloadLocation: component.url,
    filesAnalyzed: false,
    licenseConcluded: spdxLicense(component.license),
    licenseDeclared: spdxLicense(component.license),
    copyrightText: 'NOASSERTION',
    ...(component.hash ? { checksums: [{ algorithm: 'SHA256', checksumValue: component.hash }] } : {}),
    externalRefs: [{ referenceCategory: 'OTHER', referenceType: 'motion-previs-scope', referenceLocator: component.scope }]
  };
}

function spdxLicense(value) {
  if (value.startsWith('Apache-2.0')) return 'Apache-2.0';
  if (value === 'MIT') return 'MIT';
  if (value === 'ISC') return 'ISC';
  if (value === 'Unlicense') return 'Unlicense';
  if (value.startsWith('GPL-3.0')) return 'GPL-3.0-or-later';
  return 'NOASSERTION';
}

function spdxId(value) {
  return `SPDXRef-${value.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}
