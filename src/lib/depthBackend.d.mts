export const DEPTH_GPU_DEVICE: 'webgpu';
export const DEPTH_CPU_DEVICE: 'wasm';

export function probeWebGpuAdapter(gpu?: {
  requestAdapter?: () => unknown | Promise<unknown>;
}): Promise<boolean>;

export function createDevicePipelineWithFallback<T>(options: {
  pipeline: (task: string, repository: string, options: Record<string, unknown>) => Promise<T>;
  task: string;
  repository: string;
  options: Record<string, unknown>;
  probeWebGpu?: () => boolean | Promise<boolean>;
  onFallback?: (error: unknown) => void;
  onCpuReady?: () => void;
  onWebGpuFailure?: (error: unknown) => void;
}): Promise<T>;

export function createRetryableAsync<TArgs extends unknown[], TResult>(
  factory: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult>;
