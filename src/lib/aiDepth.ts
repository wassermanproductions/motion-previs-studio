import type { ProgressFn } from '../types';

type DepthImage = {
  resize: (width: number, height: number) => Promise<{ toCanvas: () => HTMLCanvasElement }>;
};

type DepthEstimator = (input: unknown) => Promise<{ depth: DepthImage } | Array<{ depth: DepthImage }>>;

let estimatorPromise: Promise<DepthEstimator> | null = null;

export async function createAiDepthVideoBlob(
  videoUrl: string,
  fps: number,
  width: number,
  height: number,
  progress?: ProgressFn
) {
  const [{ RawImage }, estimator] = await Promise.all([import('@huggingface/transformers'), loadDepthEstimator(progress)]);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;
  await waitForMetadata(video);

  const inputCanvas = document.createElement('canvas');
  const maxInput = 384;
  const sourceRatio = video.videoWidth / video.videoHeight;
  inputCanvas.width = sourceRatio >= 1 ? maxInput : Math.round(maxInput * sourceRatio);
  inputCanvas.height = sourceRatio >= 1 ? Math.round(maxInput / sourceRatio) : maxInput;
  const inputCtx = inputCanvas.getContext('2d');
  if (!inputCtx) throw new Error('Could not create AI depth input canvas.');

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) throw new Error('Could not create AI depth output canvas.');

  const stream = outputCanvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, chooseMimeType() ? { mimeType: chooseMimeType() } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  for (let index = 0; index < totalFrames; index += 1) {
    const time = Math.min(index / fps, Math.max(duration - 0.001, 0));
    await seekVideo(video, time);
    inputCtx.drawImage(video, 0, 0, inputCanvas.width, inputCanvas.height);
    const raw = RawImage.fromCanvas(inputCanvas);
    const outputRaw = await estimator(raw);
    const output = Array.isArray(outputRaw) ? outputRaw[0] : outputRaw;
    const depthImage = await output.depth.resize(width, height);
    const depthCanvas = depthImage.toCanvas();
    outputCtx.drawImage(depthCanvas, 0, 0, width, height);
    track.requestFrame?.();
    progress?.(0.7 + (index / totalFrames) * 0.12, `Rendering AI depth ${index + 1}/${totalFrames}`);
    await delay(1000 / fps);
  }

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((item) => item.stop());
  return new Blob(chunks, { type: chooseMimeType() || 'video/webm' });
}

async function loadDepthEstimator(progress?: ProgressFn): Promise<DepthEstimator> {
  if (!estimatorPromise) {
    estimatorPromise = (async () => {
      progress?.(0.65, 'Loading Depth Anything model');
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = true;
      const options = {
        dtype: 'q8' as const,
        progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
          if (event.status === 'progress') {
            progress?.(0.65, `Downloading depth model ${Math.round(event.progress || 0)}%`);
          }
        }
      };
      try {
        return (await pipeline('depth-estimation', 'Xenova/depth-anything-small-hf', {
          ...options,
          device: 'webgpu'
        })) as unknown as DepthEstimator;
      } catch {
        return (await pipeline('depth-estimation', 'Xenova/depth-anything-small-hf', options)) as unknown as DepthEstimator;
      }
    })();
  }
  return estimatorPromise;
}

function chooseMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
