'use strict';

/**
 * Unit-ish tests for the v4 phase-2 engines (src/lib/openpose.ts,
 * src/lib/cameraMotion.ts). These modules are TypeScript that pull in browser
 * types, so — as with tests/quality-sync.cjs — we transpile each to CommonJS
 * with the project's own `typescript` dependency and evaluate the result in a
 * sandbox with light DOM stubs. Only pure, deterministic functions are exercised
 * here (mapping, RANSAC, LCG); nothing that needs a real canvas/video.
 *
 * Run: node tests/engines.cjs   (npm run verify:engines)
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures += 1;
  }
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ~${b}, tol ${tol})`);
}

/** Transpile a project .ts module and run it in a sandbox, returning its exports. */
function loadTsModule(relPath, extraSandbox = {}) {
  const abs = path.join(root, relPath);
  const source = fs.readFileSync(abs, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      isolatedModules: true,
      esModuleInterop: true
    },
    fileName: path.basename(relPath)
  });

  const localRequire = (spec) => {
    // Resolve sibling ./ imports to already-loaded stubs or transpiled modules.
    if (spec.startsWith('.')) {
      const resolved = path.join(path.dirname(relPath), spec);
      // Type-only imports (e.g. '../types') carry no runtime; return empty.
      if (resolved.includes('types')) return {};
      if (resolved.includes('frameEncoder')) return { encodeFrames: async () => new Uint8Array() };
      if (resolved.includes('pose')) {
        // openpose.ts does not import pose at runtime, but guard anyway.
        return {};
      }
      return loadTsModule(`${resolved}.ts`, extraSandbox);
    }
    return require(spec);
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: localRequire,
    Number,
    Math,
    Array,
    Uint8Array,
    Uint8ClampedArray,
    Float32Array,
    console,
    ...extraSandbox
  };
  sandbox.module.exports = sandbox.exports;
  vm.createContext(sandbox);
  vm.runInContext(outputText, sandbox, { filename: `${relPath} (transpiled)` });
  return sandbox.module.exports;
}

// ---------------------------------------------------------------------------
// 1. OpenPose BODY_25 mapping
// ---------------------------------------------------------------------------

function testOpenPoseMapping() {
  const op = loadTsModule('src/lib/openpose.ts');

  // Build 33 MediaPipe landmarks with distinct, known normalized coords so we
  // can read the mapping back by value. x = i/100, y = i/50, visibility = 1.
  const landmarks = Array.from({ length: 33 }, (_, i) => ({
    x: i / 100,
    y: i / 50,
    z: 0,
    visibility: 1
  }));

  const W = 1000;
  const H = 500;
  const kps = op.mediaPipeToBody25(landmarks, W, H);
  assert(kps.length === 25, `BODY_25 must have 25 keypoints (got ${kps.length})`);

  // Direct-copy joints: BODY_25[2] = RShoulder <- MediaPipe 12.
  approx(kps[2].x, (12 / 100) * W, 1e-6, 'RShoulder x maps from MediaPipe 12');
  approx(kps[2].y, (12 / 50) * H, 1e-6, 'RShoulder y maps from MediaPipe 12');
  // BODY_25[5] = LShoulder <- MediaPipe 11.
  approx(kps[5].x, (11 / 100) * W, 1e-6, 'LShoulder x maps from MediaPipe 11');
  // BODY_25[4] = RWrist <- MediaPipe 16.
  approx(kps[4].x, (16 / 100) * W, 1e-6, 'RWrist x maps from MediaPipe 16');
  // BODY_25[15] = REye <- MediaPipe 5; BODY_25[16] = LEye <- MediaPipe 2.
  approx(kps[15].x, (5 / 100) * W, 1e-6, 'REye x maps from MediaPipe 5');
  approx(kps[16].x, (2 / 100) * W, 1e-6, 'LEye x maps from MediaPipe 2');

  // Derived midpoints.
  // Neck (index 1) = midpoint(11, 12).
  approx(kps[1].x, ((11 + 12) / 2 / 100) * W, 1e-6, 'Neck x = midpoint of shoulders');
  approx(kps[1].y, ((11 + 12) / 2 / 50) * H, 1e-6, 'Neck y = midpoint of shoulders');
  // MidHip (index 8) = midpoint(23, 24).
  approx(kps[8].x, ((23 + 24) / 2 / 100) * W, 1e-6, 'MidHip x = midpoint of hips');
  approx(kps[8].y, ((23 + 24) / 2 / 50) * H, 1e-6, 'MidHip y = midpoint of hips');

  // Confidence-0 fill: when a source landmark is missing, its keypoint is 0/0/0.
  const sparse = Array.from({ length: 33 }, (_, i) => (i === 0 ? { x: 0.5, y: 0.5, z: 0, visibility: 1 } : null));
  // Wipe everything but the nose so shoulders (11,12) are absent.
  const kps2 = op.mediaPipeToBody25(sparse.map((v) => v || { x: 0, y: 0, z: 0, visibility: 0 }), W, H);
  // Nose present -> confidence 1.
  approx(kps2[0].c, 1, 1e-6, 'Nose confidence carried through');
  // Shoulders had visibility 0 -> their confidence is 0.
  assert(kps2[2].c === 0, `RShoulder confidence 0 when source invisible (got ${kps2[2].c})`);
  // Neck derived from two zero-visibility shoulders -> confidence 0.
  assert(kps2[1].c === 0, `Neck confidence 0 when both shoulders invisible (got ${kps2[1].c})`);

  // Flat array is 75 numbers (25 * [x,y,c]).
  const flat = op.keypointsToFlatArray(kps);
  assert(flat.length === 75, `flat keypoints array length 75 (got ${flat.length})`);
  approx(flat[6], kps[2].x, 1e-6, 'flat array preserves RShoulder x at offset 6');

  console.log('  [openpose] mapping, midpoints, confidence-0 fill, flat array: OK');
}

// ---------------------------------------------------------------------------
// 2. Similarity RANSAC on synthetic point sets
// ---------------------------------------------------------------------------

function applySimilarity(x, y, scale, rot, tx, ty) {
  const c = scale * Math.cos(rot);
  const s = scale * Math.sin(rot);
  return { x: c * x - s * y + tx, y: s * x + c * y + ty };
}

function testRansac() {
  const cam = loadTsModule('src/lib/cameraMotion.ts');
  const rand = cam.makeLcg(12345);

  const trueScale = 1.05;
  const trueRot = 0.08; // radians
  const trueTx = 7.5;
  const trueTy = -4.2;

  const W = 192;
  const H = 108;
  const matches = [];
  // 80 inliers following the true transform.
  for (let i = 0; i < 80; i += 1) {
    const x0 = rand() * W;
    const y0 = rand() * H;
    const p = applySimilarity(x0, y0, trueScale, trueRot, trueTx, trueTy);
    matches.push({ x0, y0, x1: p.x, y1: p.y });
  }
  // 40 gross outliers (subject motion / mistracks): random destinations.
  for (let i = 0; i < 40; i += 1) {
    const x0 = rand() * W;
    const y0 = rand() * H;
    matches.push({ x0, y0, x1: rand() * W, y1: rand() * H });
  }

  const est = cam.estimateSimilarityRansac(matches, W, H);
  approx(est.scale, trueScale, 0.02, 'RANSAC recovers scale');
  approx(est.rotation, trueRot, 0.02, 'RANSAC recovers rotation');
  approx(est.tx, trueTx, 1.0, 'RANSAC recovers tx');
  approx(est.ty, trueTy, 1.0, 'RANSAC recovers ty');
  // Inlier ratio should reflect ~80/120.
  assert(est.inlierRatio > 0.55, `inlier ratio reflects majority inliers (got ${est.inlierRatio})`);

  // Pure translation, no outliers.
  const transMatches = [];
  for (let i = 0; i < 30; i += 1) {
    const x0 = rand() * W;
    const y0 = rand() * H;
    transMatches.push({ x0, y0, x1: x0 + 12, y1: y0 - 3 });
  }
  const est2 = cam.estimateSimilarityRansac(transMatches, W, H);
  approx(est2.tx, 12, 0.5, 'pure-translation tx');
  approx(est2.ty, -3, 0.5, 'pure-translation ty');
  approx(est2.scale, 1, 0.01, 'pure-translation scale ~1');
  approx(est2.rotation, 0, 0.01, 'pure-translation rotation ~0');

  // Determinism: identical inputs => identical output.
  const estA = cam.estimateSimilarityRansac(matches, W, H);
  const estB = cam.estimateSimilarityRansac(matches, W, H);
  assert(
    estA.tx === estB.tx && estA.ty === estB.ty && estA.scale === estB.scale && estA.rotation === estB.rotation,
    'RANSAC is deterministic across runs on the same input'
  );

  console.log('  [camera] similarity RANSAC recovery + determinism: OK');
}

// ---------------------------------------------------------------------------
// 3. LCG determinism
// ---------------------------------------------------------------------------

function testLcg() {
  const cam = loadTsModule('src/lib/cameraMotion.ts');
  const a = cam.makeLcg(42);
  const b = cam.makeLcg(42);
  const c = cam.makeLcg(43);

  const seqA = Array.from({ length: 16 }, () => a());
  const seqB = Array.from({ length: 16 }, () => b());
  const seqC = Array.from({ length: 16 }, () => c());

  assert(JSON.stringify(seqA) === JSON.stringify(seqB), 'same seed => identical sequence');
  assert(JSON.stringify(seqA) !== JSON.stringify(seqC), 'different seed => different sequence');
  for (const v of seqA) {
    assert(v >= 0 && v < 1, `LCG output in [0,1) (got ${v})`);
  }
  console.log('  [lcg] seeded determinism + range: OK');
}

function main() {
  console.log('verify:engines');
  testOpenPoseMapping();
  testRansac();
  testLcg();
  if (failures > 0) {
    console.error(`verify:engines FAILED with ${failures} assertion failure(s).`);
    process.exit(1);
  }
  console.log('verify:engines: OK');
}

main();
