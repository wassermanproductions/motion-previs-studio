export const DEPTH_GPU_DEVICE = 'webgpu';
export const DEPTH_CPU_DEVICE = 'wasm';

export async function createDevicePipelineWithFallback({ pipeline, task, repository, options, onFallback, onCpuReady }) {
  try {
    return await pipeline(task, repository, { ...options, device: DEPTH_GPU_DEVICE });
  } catch (error) {
    onFallback?.(error);
    const estimator = await pipeline(task, repository, { ...options, device: DEPTH_CPU_DEVICE });
    onCpuReady?.();
    return estimator;
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
