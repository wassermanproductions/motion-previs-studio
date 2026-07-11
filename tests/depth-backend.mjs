import assert from 'node:assert/strict';
import {
  createDevicePipelineWithFallback,
  createRetryableAsync,
  DEPTH_CPU_DEVICE,
  DEPTH_GPU_DEVICE,
  probeWebGpuAdapter
} from '../src/lib/depthBackend.mjs';

const revision = '2e942621ab9f2371c1df9eb223291b5ac31475e6';
const progressCallback = () => undefined;
const calls = [];
const estimator = async () => ({ depth: { backend: 'wasm', revision } });
assert.equal(await probeWebGpuAdapter(undefined), false, 'an absent WebGPU API must select WASM');
assert.equal(await probeWebGpuAdapter({ requestAdapter: async () => null }), false, 'a null adapter must select WASM');
await assert.rejects(
  probeWebGpuAdapter({ requestAdapter: async () => { throw new Error('adapter probe failed'); } }),
  /adapter probe failed/,
  'a thrown adapter probe must be observable by the fallback selector'
);
assert.equal(await probeWebGpuAdapter({ requestAdapter: async () => ({ name: 'adapter' }) }), true, 'a real adapter must permit WebGPU');

const fallbackErrors = [];
const loaded = await createDevicePipelineWithFallback({
  pipeline: async (_task, _repository, options) => {
    calls.push(options);
    return estimator;
  },
  task: 'depth-estimation',
  repository: 'Xenova/depth-anything-small-hf',
  options: { dtype: 'q8', revision, progress_callback: progressCallback },
  probeWebGpu: async () => false,
  onFallback: (error) => fallbackErrors.push(error)
});
const output = await loaded('frame');
assert.equal(output.depth.backend, 'wasm');
assert.equal(output.depth.revision, revision);
assert.deepEqual(calls.map((options) => options.device), [DEPTH_CPU_DEVICE]);
assert.match(String(fallbackErrors[0]), /No WebGPU adapter/);
for (const options of calls) {
  assert.equal(options.revision, revision);
  assert.equal(options.dtype, 'q8');
  assert.equal(options.progress_callback, progressCallback);
}

const thrownProbeDevices = [];
const thrownProbeFallbacks = [];
await createDevicePipelineWithFallback({
  pipeline: async (_task, _repository, options) => {
    thrownProbeDevices.push(options.device);
    return estimator;
  },
  task: 'depth-estimation',
  repository: 'Xenova/depth-anything-small-hf',
  options: { dtype: 'q8', revision },
  probeWebGpu: async () => { throw new Error('adapter probe failed'); },
  onFallback: (error) => thrownProbeFallbacks.push(error)
});
assert.deepEqual(thrownProbeDevices, [DEPTH_CPU_DEVICE]);
assert.match(String(thrownProbeFallbacks[0]), /adapter probe failed/);

const successfulGpuDevices = [];
const gpuEstimator = await createDevicePipelineWithFallback({
  pipeline: async (_task, _repository, options) => {
    successfulGpuDevices.push(options.device);
    return estimator;
  },
  task: 'depth-estimation',
  repository: 'Xenova/depth-anything-small-hf',
  options: { dtype: 'q8', revision },
  probeWebGpu: async () => true
});
assert.equal((await gpuEstimator('frame')).depth.revision, revision);
assert.deepEqual(successfulGpuDevices, [DEPTH_GPU_DEVICE]);

const failedGpuDevices = [];
await assert.rejects(
  createDevicePipelineWithFallback({
    pipeline: async (_task, _repository, options) => {
      failedGpuDevices.push(options.device);
      throw new Error('WebGPU model initialization failed.');
    },
    task: 'depth-estimation',
    repository: 'Xenova/depth-anything-small-hf',
    options: { dtype: 'q8', revision },
    probeWebGpu: async () => true
  }),
  /Restart the app with GPU disabled/,
  'a failed WebGPU initializer must not claim an impossible same-module WASM fallback'
);
assert.deepEqual(failedGpuDevices, [DEPTH_GPU_DEVICE]);

let loadRounds = 0;
const retryDevices = [];
const retryable = createRetryableAsync(async () => {
  const round = ++loadRounds;
  return createDevicePipelineWithFallback({
    pipeline: async (_task, _repository, options) => {
      retryDevices.push(options.device);
      if (round === 1) {
        throw new Error(`round ${round} ${options.device} unavailable`);
      }
      return estimator;
    },
    task: 'depth-estimation',
    repository: 'Xenova/depth-anything-small-hf',
    options: { dtype: 'q8', revision },
    probeWebGpu: async () => false
  });
});
await assert.rejects(retryable(), /round 1 wasm unavailable/);
const retriedEstimator = await retryable();
assert.equal((await retriedEstimator('frame')).depth.backend, 'wasm');
assert.equal(loadRounds, 2, 'a terminal WASM failure must clear the cached estimator promise');
assert.deepEqual(retryDevices, [DEPTH_CPU_DEVICE, DEPTH_CPU_DEVICE]);

let concurrentAttempts = 0;
const shared = createRetryableAsync(async () => {
  concurrentAttempts += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return 'shared';
});
assert.deepEqual(await Promise.all([shared(), shared()]), ['shared', 'shared']);
assert.equal(concurrentAttempts, 1, 'concurrent loads must share one estimator promise');

console.log('verify:depth-backend: absent/null/thrown/successful adapter preflight, explicit WASM fallback, pinned options, output, retry cache: OK');
