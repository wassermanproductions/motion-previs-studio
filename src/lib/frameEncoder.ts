/**
 * Deterministic frame encoder (renderer side).
 *
 * Replaces MediaRecorder + canvas.captureStream, which encoded on a wall-clock
 * timer and silently dropped or duplicated frames under load. Instead we render
 * every frame to a canvas, serialize it to a PNG blob, and stream the bytes to
 * the main process (electron/frameEncode.cjs), which pipes them straight into
 * ffmpeg (`-f image2pipe -framerate <fps>`) to produce an H.264 mp4. The number
 * of frames encoded exactly equals the number of frames we draw.
 *
 * `encodeFrames` returns the mp4 as a Blob so existing callers (App.tsx's
 * exportBundle, the e2e harness) can keep doing `blob.arrayBuffer()` unchanged.
 */

export type FrameRenderer = (index: number) => void | Promise<void>;

export type EncodeFramesOptions = {
  canvas: HTMLCanvasElement;
  fps: number;
  frameCount: number;
  /** Draw frame `index` onto the shared canvas. Called once per frame, in order. */
  renderFrame: FrameRenderer;
  /** Optional progress hook: (fraction 0..1, index, total). */
  onProgress?: (fraction: number, index: number, total: number) => void;
};

type EncoderBridge = {
  encodeFramesBegin: (payload: { fps: number; width: number; height: number }) => Promise<{ sessionId: string }>;
  encodeFramesFrame: (payload: { sessionId: string; buffer: ArrayBuffer }) => Promise<{ frames: number }>;
  encodeFramesEnd: (payload: { sessionId: string }) => Promise<{ buffer: ArrayBuffer; frames: number }>;
};

function bridge(): EncoderBridge {
  const api = (window as unknown as { motionPrevis?: Partial<EncoderBridge> }).motionPrevis;
  if (!api || !api.encodeFramesBegin || !api.encodeFramesFrame || !api.encodeFramesEnd) {
    throw new Error('Deterministic frame encoder bridge is not available (desktop only).');
  }
  return api as EncoderBridge;
}

/** Serialize the current canvas contents to PNG bytes. */
function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob returned null while encoding a frame.'));
        return;
      }
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

/**
 * Render `frameCount` frames deterministically and return the encoded H.264
 * mp4 as a Blob. Each frame is drawn, captured to PNG, and streamed to main in
 * order; there is no timer and no captureStream, so the output is reproducible.
 */
export async function encodeFrames(options: EncodeFramesOptions): Promise<Blob> {
  const { canvas, renderFrame, onProgress } = options;
  const fps = Math.min(Math.max(Math.round(options.fps) || 12, 1), 60);
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const api = bridge();

  const { sessionId } = await api.encodeFramesBegin({ fps, width: canvas.width, height: canvas.height });
  try {
    for (let index = 0; index < frameCount; index += 1) {
      await renderFrame(index);
      const png = await canvasToPngBytes(canvas);
      await api.encodeFramesFrame({ sessionId, buffer: png });
      onProgress?.((index + 1) / frameCount, index, frameCount);
    }
    const { buffer } = await api.encodeFramesEnd({ sessionId });
    return new Blob([buffer], { type: 'video/mp4' });
  } catch (error) {
    // Best-effort teardown so a failed render doesn't leak an ffmpeg session.
    try {
      await api.encodeFramesEnd({ sessionId });
    } catch {
      /* already torn down or never started */
    }
    throw error;
  }
}

/** True when the deterministic encoder bridge is present (i.e. running in Electron). */
export function isFrameEncoderAvailable(): boolean {
  const api = (window as unknown as { motionPrevis?: Partial<EncoderBridge> }).motionPrevis;
  return Boolean(api && api.encodeFramesBegin && api.encodeFramesFrame && api.encodeFramesEnd);
}
