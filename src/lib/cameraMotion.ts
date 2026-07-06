import type { CameraMotionData, CameraMotionFrame, ProgressFn } from '../types';

type GrayFrame = {
  width: number;
  height: number;
  data: Uint8Array;
};

export async function analyzeCameraMotionVideo(
  videoUrl: string,
  fps: number,
  progress?: ProgressFn
): Promise<CameraMotionData> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;
  await waitForMetadata(video);

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const sampleFps = Math.min(Math.max(fps, 2), 12);
  const totalFrames = Math.max(1, Math.ceil(duration * sampleFps));
  const size = analysisSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create camera-motion analysis canvas.');

  let previous: GrayFrame | null = null;
  let cumulativeX = 0;
  let cumulativeY = 0;
  let cumulativeZoom = 1;
  let cumulativeRoll = 0;
  const frames: CameraMotionFrame[] = [];

  for (let index = 0; index < totalFrames; index += 1) {
    const time = Math.min(index / sampleFps, Math.max(duration - 0.001, 0));
    await seekVideo(video, time);
    ctx.drawImage(video, 0, 0, size.width, size.height);
    const current = toGrayFrame(ctx.getImageData(0, 0, size.width, size.height));

    let imageMotion = { xPixels: 0, yPixels: 0, scale: 1, rollRadians: 0 };
    let confidence = 1;
    if (previous) {
      const transform = estimateGlobalTransform(previous, current);
      const scaleX = video.videoWidth / size.width;
      const scaleY = video.videoHeight / size.height;
      imageMotion = {
        xPixels: transform.dx * scaleX,
        yPixels: transform.dy * scaleY,
        scale: transform.scale,
        rollRadians: transform.roll
      };
      confidence = transform.confidence;
      cumulativeX += imageMotion.xPixels;
      cumulativeY += imageMotion.yPixels;
      cumulativeZoom *= transform.scale;
      cumulativeRoll += transform.roll;
    }

    frames.push({
      time,
      frameIndex: index,
      imageMotion,
      cameraMove: {
        pan: -cumulativeX / Math.max(video.videoWidth, 1),
        tilt: -cumulativeY / Math.max(video.videoHeight, 1),
        dollyZoom: cumulativeZoom,
        roll: -cumulativeRoll
      },
      confidence
    });

    previous = current;
    progress?.(0.8 + (index / totalFrames) * 0.08, `Solving camera move ${index + 1}/${totalFrames}`);
  }

  const last = frames[frames.length - 1];
  const averageConfidence = frames.reduce((sum, frame) => sum + frame.confidence, 0) / Math.max(frames.length, 1);
  return {
    fps: sampleFps,
    duration,
    width: video.videoWidth,
    height: video.videoHeight,
    frames,
    summary: {
      panPixels: last ? -last.cameraMove.pan * video.videoWidth : 0,
      tiltPixels: last ? -last.cameraMove.tilt * video.videoHeight : 0,
      zoomRatio: last?.cameraMove.dollyZoom || 1,
      rollDegrees: ((last?.cameraMove.roll || 0) * 180) / Math.PI,
      averageConfidence
    }
  };
}

function analysisSize(width: number, height: number) {
  const longEdge = 96;
  if (width >= height) {
    return { width: longEdge, height: Math.max(32, Math.round((height / width) * longEdge)) };
  }
  return { width: Math.max(32, Math.round((width / height) * longEdge)), height: longEdge };
}

function toGrayFrame(image: ImageData): GrayFrame {
  const out = new Uint8Array(image.width * image.height);
  for (let index = 0, cursor = 0; index < image.data.length; index += 4, cursor += 1) {
    out[cursor] = Math.round(image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114);
  }
  return { width: image.width, height: image.height, data: out };
}

function estimateGlobalTransform(previous: GrayFrame, current: GrayFrame) {
  const maxShift = Math.max(4, Math.round(Math.min(previous.width, previous.height) * 0.08));
  const scales = [0.965, 0.982, 1, 1.018, 1.035];
  let best = { dx: 0, dy: 0, scale: 1, error: Number.POSITIVE_INFINITY };

  for (const scale of scales) {
    for (let dy = -maxShift; dy <= maxShift; dy += 1) {
      for (let dx = -maxShift; dx <= maxShift; dx += 1) {
        const error = compareShift(previous, current, dx, dy, scale);
        if (error < best.error) best = { dx, dy, scale, error };
      }
    }
  }

  const topShift = estimateBandShift(previous, current, 'top', maxShift);
  const bottomShift = estimateBandShift(previous, current, 'bottom', maxShift);
  const roll = clamp((bottomShift - topShift) / Math.max(previous.height, 1), -0.08, 0.08);
  const confidence = clamp(1 - best.error / 72, 0, 1);
  return { ...best, roll, confidence };
}

function compareShift(previous: GrayFrame, current: GrayFrame, dx: number, dy: number, scale: number) {
  const width = previous.width;
  const height = previous.height;
  const cx = width / 2;
  const cy = height / 2;
  let total = 0;
  let weightTotal = 0;

  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
      const sourceX = Math.round(cx + (x - cx) / scale - dx);
      const sourceY = Math.round(cy + (y - cy) / scale - dy);
      if (sourceX < 1 || sourceX >= width - 1 || sourceY < 1 || sourceY >= height - 1) continue;
      const weight = backgroundWeight(x, y, width, height);
      const diff = Math.abs(current.data[y * width + x] - previous.data[sourceY * width + sourceX]);
      total += diff * weight;
      weightTotal += weight;
    }
  }

  return weightTotal ? total / weightTotal : Number.POSITIVE_INFINITY;
}

function estimateBandShift(previous: GrayFrame, current: GrayFrame, band: 'top' | 'bottom', maxShift: number) {
  const width = previous.width;
  const height = previous.height;
  const yStart = band === 'top' ? 2 : Math.floor(height * 0.68);
  const yEnd = band === 'top' ? Math.floor(height * 0.32) : height - 2;
  let bestDx = 0;
  let bestError = Number.POSITIVE_INFINITY;

  for (let dx = -maxShift; dx <= maxShift; dx += 1) {
    let total = 0;
    let count = 0;
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = maxShift + 1; x < width - maxShift - 1; x += 2) {
        const sourceX = x - dx;
        const diff = Math.abs(current.data[y * width + x] - previous.data[y * width + sourceX]);
        total += diff;
        count += 1;
      }
    }
    const error = count ? total / count : Number.POSITIVE_INFINITY;
    if (error < bestError) {
      bestError = error;
      bestDx = dx;
    }
  }

  return bestDx;
}

function backgroundWeight(x: number, y: number, width: number, height: number) {
  const nx = Math.abs(x / width - 0.5) * 2;
  const ny = Math.abs(y / height - 0.5) * 2;
  const edgeBias = Math.max(nx, ny);
  return edgeBias > 0.48 ? 1.25 : 0.42;
}

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading video metadata for camera motion.')), 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load video for camera-motion analysis.'));
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
