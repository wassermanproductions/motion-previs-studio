export const DEPTH_GPU_DEVICE = 'webgpu';
export const DEPTH_CPU_DEVICE = 'wasm';

export async function probeWebGpuAdapter(gpu) {
  if (!gpu?.requestAdapter) return false;
  return Boolean(await gpu.requestAdapter());
}

export async function createDevicePipelineWithFallback({ pipeline, task, repository, options, probeWebGpu, onFallback, onCpuReady, onWebGpuFailure }) {
  const loadCpu = async () => {
    const estimator = await pipeline(task, repository, { ...options, device: DEPTH_CPU_DEVICE });
    onCpuReady?.();
    return estimator;
  };

  if (probeWebGpu) {
    let webGpuAvailable;
    try {
      webGpuAvailable = await probeWebGpu();
    } catch (error) {
      onFallback?.(error);
      return await loadCpu();
    }
    if (!webGpuAvailable) {
      onFallback?.(new Error('No WebGPU adapter is available.'));
      return await loadCpu();
    }
  }

  try {
    return await pipeline(task, repository, { ...options, device: DEPTH_GPU_DEVICE });
  } catch (error) {
    onWebGpuFailure?.(error);
    throw new Error(
      'WebGPU initialization failed after adapter preflight. Restart the app with GPU disabled to use the CPU/WASM backend without initializing WebGPU.',
      { cause: error }
    );
  }
}

export function createRetryableAsync(factory) {
  let pending = null;
  return (...args) => {
    if (!pending) {
      const current = Promise.resolve().then(() => factory(...args));
      pending = current;
      void current.catch(() => {
        if (pending === current) pending = null;
      });
    }
    return pending;
  };
}
