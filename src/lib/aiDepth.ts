import type { ProgressFn } from '../types';
import { encodeFrames } from './frameEncoder';

type DepthImage = {
  resize: (width: number, height: number) => Promise<{ toCanvas: () => HTMLCanvasElement }>;
};

type DepthEstimator = (input: unknown) => Promise<{ depth: DepthImage } | Array<{ depth: DepthImage }>>;

let estimatorPromise: Promise<DepthEstimator> | null = null;
const DEPTH_ANYTHING_REPOSITORY = 'Xenova/depth-anything-small-hf';
export const DEPTH_ANYTHING_REVISION = '2e942621ab9f2371c1df9eb223291b5ac31475e6';

export async function createAiDepthVideoBlob(
  videoUrl: string,
  fps: number,
  width: number,
  height: number,
  progress?: ProgressFn,
  signal?: AbortSignal
) {
  const [{ RawImage }, estimator] = await Promise.all([import('@huggingface/transformers'), loadDepthEstimator(progress)]);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  const inputCanvas = document.createElement('canvas');
  const outputCanvas = document.createElement('canvas');

  try {
    await waitForMetadata(video);

    const maxInput = 384;
    const sourceRatio = video.videoWidth / video.videoHeight;
    inputCanvas.width = sourceRatio >= 1 ? maxInput : Math.round(maxInput * sourceRatio);
    inputCanvas.height = sourceRatio >= 1 ? Math.round(maxInput / sourceRatio) : maxInput;
    const inputCtx = inputCanvas.getContext('2d');
    if (!inputCtx) throw new Error('Could not create AI depth input canvas.');

    outputCanvas.width = width;
    outputCanvas.height = height;
    const outputCtx = outputCanvas.getContext('2d');
    if (!outputCtx) throw new Error('Could not create AI depth output canvas.');

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const totalFrames = Math.max(1, Math.ceil(duration * fps));

    // v4: deterministic encode — one estimator pass per frame, streamed to
    // ffmpeg as PNGs. No MediaRecorder/captureStream, so the exact frame count
    // is preserved and the output is a reproducible H.264 mp4 (Blob).
    return await encodeFrames({
      canvas: outputCanvas,
      fps,
      frameCount: totalFrames,
      signal,
      renderFrame: async (index) => {
        const time = Math.min(index / fps, Math.max(duration - 0.001, 0));
        await seekVideo(video, time);
        inputCtx.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height);
        const raw = RawImage.fromCanvas(inputCanvas);
        const outputRaw = await estimator(raw);
        const output = Array.isArray(outputRaw) ? outputRaw[0] : outputRaw;
        const depthImage = await output.depth.resize(width, height);
        const depthCanvas = depthImage.toCanvas();
        outputCtx.drawImage(depthCanvas, 0, 0, width, height);
      },
      onProgress: (fraction, index) => {
        progress?.(0.7 + fraction * 0.12, `Rendering AI depth ${index + 1}/${totalFrames}`);
      }
    });
  } finally {
    releaseVideo(video);
    inputCanvas.width = 0;
    inputCanvas.height = 0;
    outputCanvas.width = 0;
    outputCanvas.height = 0;
  }
}

/** Release a hidden <video> element's resources. */
function releaseVideo(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  video.removeAttribute('src');
  video.src = '';
  try {
    video.load();
  } catch {
    /* ignore */
  }
  video.remove();
}

async function loadDepthEstimator(progress?: ProgressFn): Promise<DepthEstimator> {
  if (!estimatorPromise) {
    estimatorPromise = (async () => {
      progress?.(0.65, 'Loading Depth Anything model');
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = true;
      const options = {
        dtype: 'q8' as const,
        revision: DEPTH_ANYTHING_REVISION,
        progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
          if (event.status === 'progress') {
            progress?.(0.65, `Downloading depth model ${Math.round(event.progress || 0)}%`);
          }
        }
      };
      try {
        return (await pipeline('depth-estimation', DEPTH_ANYTHING_REPOSITORY, {
          ...options,
          device: 'webgpu'
        })) as unknown as DepthEstimator;
      } catch {
        return (await pipeline('depth-estimation', DEPTH_ANYTHING_REPOSITORY, options)) as unknown as DepthEstimator;
      }
    })();
  }
  return estimatorPromise;
}

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading video metadata for AI depth.')), 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load video for AI depth analysis.'));
    };
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Timed out seeking video to ${time.toFixed(2)}s.`)), 10000);
    const done = () => {
      window.clearTimeout(timeout);
      video.onseeked = null;
      resolve();
    };
    video.onseeked = done;
    video.currentTime = time;
    if (Math.abs(video.currentTime - time) < 0.002 && video.readyState >= 2) {
      requestAnimationFrame(done);
    }
  });
}
