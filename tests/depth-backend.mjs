import assert from 'node:assert/strict';
import {
  createDevicePipelineWithFallback,
  createRetryableAsync,
  DEPTH_CPU_DEVICE,
  DEPTH_GPU_DEVICE
} from '../src/lib/depthBackend.mjs';

const revision = '2e942621ab9f2371c1df9eb223291b5ac31475e6';
const progressCallback = () => undefined;
const calls = [];
const estimator = async () => ({ depth: { backend: 'wasm', revision } });
const loaded = await createDevicePipelineWithFallback({
  pipeline: async (_task, _repository, options) => {
    calls.push(options);
    if (options.device === DEPTH_GPU_DEVICE) throw new Error('No available adapters.');
    return estimator;
  },
  task: 'depth-estimation',
  repository: 'Xenova/depth-anything-small-hf',
  options: { dtype: 'q8', revision, progress_callback: progressCallback }
});
const output = await loaded('frame');
assert.equal(output.depth.backend, 'wasm');
assert.equal(output.depth.revision, revision);
assert.deepEqual(calls.map((options) => options.device), [DEPTH_GPU_DEVICE, DEPTH_CPU_DEVICE]);
for (const options of calls) {
  assert.equal(options.revision, revision);
  assert.equal(options.dtype, 'q8');
  assert.equal(options.progress_callback, progressCallback);
}

let loadRounds = 0;
const retryDevices = [];
const retryable = createRetryableAsync(async () => {
  const round = ++loadRounds;
  return createDevicePipelineWithFallback({
    pipeline: async (_task, _repository, options) => {
      retryDevices.push(options.device);
      if (options.device === DEPTH_GPU_DEVICE || round === 1) {
        throw new Error(`round ${round} ${options.device} unavailable`);
      }
      return estimator;
    },
    task: 'depth-estimation',
    repository: 'Xenova/depth-anything-small-hf',
    options: { dtype: 'q8', revision }
  });
});
await assert.rejects(retryable(), /round 1 wasm unavailable/);
const retriedEstimator = await retryable();
assert.equal((await retriedEstimator('frame')).depth.backend, 'wasm');
assert.equal(loadRounds, 2, 'a terminal WebGPU and WASM failure must clear the cached estimator promise');
assert.deepEqual(retryDevices, [DEPTH_GPU_DEVICE, DEPTH_CPU_DEVICE, DEPTH_GPU_DEVICE, DEPTH_CPU_DEVICE]);

let concurrentAttempts = 0;
const shared = createRetryableAsync(async () => {
  concurrentAttempts += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return 'shared';
});
assert.deepEqual(await Promise.all([shared(), shared()]), ['shared', 'shared']);
assert.equal(concurrentAttempts, 1, 'concurrent loads must share one estimator promise');

console.log('verify:depth-backend: explicit WebGPU to WASM fallback, pinned options, output, retry cache: OK');
