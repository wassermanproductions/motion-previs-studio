'use strict';

/**
 * Sync check: shared/quality.cjs (source of truth) and src/lib/quality.ts
 * (renderer mirror) MUST agree on constants and on scores/readiness/bands/notes
 * for a matrix of inputs.
 *
 * src/lib/quality.ts is TypeScript, so we transpile it to CommonJS using the
 * project's own `typescript` dependency (no build artifacts needed) and evaluate
 * the result in-process, then compare it against shared/quality.cjs.
 *
 * Run: node tests/quality-sync.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const shared = require(path.join(root, 'shared', 'quality.cjs'));

function loadTsMirror() {
  const tsPath = path.join(root, 'src', 'lib', 'quality.ts');
  const source = fs.readFileSync(tsPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      isolatedModules: true,
      esModuleInterop: true
    },
    fileName: 'quality.ts'
  });

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    Number,
    Math,
    Array,
    console
  };
  sandbox.module.exports = sandbox.exports;
  vm.createContext(sandbox);
  vm.runInContext(outputText, sandbox, { filename: 'quality.ts (transpiled)' });
  return sandbox.module.exports;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

function main() {
  const mirror = loadTsMirror();

  const constants = [
    'WEIGHT_TRACKING',
    'WEIGHT_CAMERA',
    'WEIGHT_LAYERS',
    'READY_THRESHOLD',
    'REVIEW_THRESHOLD',
    'FILLED_FRAME_CREDIT_CAP',
    'LAYER_TARGET_COUNT'
  ];
  for (const key of constants) {
    assert(shared[key] === mirror[key], `constant ${key} mismatch: shared=${shared[key]} mirror=${mirror[key]}`);
  }

  // Input matrix over the whole score/readiness range, camera on and off.
  const grid = [0, 0.1, 0.25, 0.4, 0.5, 0.64, 0.7, 0.82, 0.9, 1];
  let checks = 0;
  for (const tracking of grid) {
    for (const camera of grid) {
      for (const layers of grid) {
        for (const cameraActive of [true, false]) {
          const input = {
            tracking,
            camera,
            layers,
            cameraActive,
            rawDetectedFrames: Math.round(tracking * 40),
            totalFrames: 40,
            filledFrames: Math.round(tracking * 4)
          };
          const a = shared.computeQualityReport(input);
          const b = mirror.computeQualityReport(input);
          assert(a.score === b.score, `score mismatch at ${JSON.stringify(input)}: ${a.score} vs ${b.score}`);
          assert(a.readiness === b.readiness, `readiness mismatch at ${JSON.stringify(input)}: ${a.readiness} vs ${b.readiness}`);
          assert(a.tracking === b.tracking, `tracking band mismatch at ${JSON.stringify(input)}`);
          assert(a.camera === b.camera, `camera band mismatch at ${JSON.stringify(input)}`);
          assert(a.layers === b.layers, `layers band mismatch at ${JSON.stringify(input)}`);
          assert(JSON.stringify(a.notes) === JSON.stringify(b.notes), `notes mismatch at ${JSON.stringify(input)}`);
          checks += 1;
        }
      }
    }
  }

  // Helper-function parity spot checks.
  for (const [raw, filled, total] of [[0, 0, 0], [10, 2, 20], [40, 8, 40], [5, 30, 40]]) {
    assert(
      shared.trackingScore(raw, filled, total) === mirror.trackingScore(raw, filled, total),
      `trackingScore mismatch for ${raw},${filled},${total}`
    );
  }
  for (const n of [0, 1, 3, 6, 9]) {
    assert(shared.layerScore(n) === mirror.layerScore(n), `layerScore mismatch for ${n}`);
  }
  for (const v of [0, 0.5, 0.64, 0.82, 1]) {
    assert(shared.qualityBand(v) === mirror.qualityBand(v), `qualityBand mismatch for ${v}`);
  }

  console.log(`quality-sync: OK (${checks} report comparisons + helper parity, constants matched)`);
}

main();
