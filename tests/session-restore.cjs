'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/sessionRestore.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
});
const sandbox = { module: { exports: {} }, exports: {}, require: () => ({}) };
sandbox.module.exports = sandbox.exports;
vm.createContext(sandbox);
vm.runInContext(outputText, sandbox);
const { sessionRestoreRequest, buildRelinkedSession } = sandbox.module.exports;

const saved = {
  sourcePath: 'D:\\old\\missing.mov',
  sourceName: 'missing.mov',
  sourceExists: false,
  sourceUrl: undefined,
  range: { start: 2, end: 6 },
  sampleFps: 12,
  version: '4.1.0',
  savedAt: '2026-07-10T00:00:00.000Z'
};
assert.equal(sessionRestoreRequest(saved).kind, 'relink');
assert.equal(sessionRestoreRequest({ ...saved, sourceExists: true }).kind, 'restore');
assert.equal(sessionRestoreRequest({ ...saved, sourcePath: null }), null);

const relinked = buildRelinkedSession(saved, { filePath: 'E:\\new\\clip.mov', name: 'clip.mov' });
assert.equal(relinked.sourcePath, 'E:\\new\\clip.mov');
assert.equal(relinked.sourceName, 'clip.mov');
assert.deepEqual(relinked.range, { start: 2, end: 6 });
assert.equal('sourceExists' in relinked, false);
assert.equal('sourceUrl' in relinked, false);
assert.equal('version' in relinked, false);

console.log('verify:session: OK');
