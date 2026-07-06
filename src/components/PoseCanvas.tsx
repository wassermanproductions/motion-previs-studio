import { useEffect, useRef } from 'react';
import type { PoseFrame } from '../types';
import { drawPoseFrame } from '../lib/poseVideo';

type PoseCanvasProps = {
  frame?: PoseFrame;
  width: number;
  height: number;
};

export function PoseCanvas({ frame, width, height }: PoseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawPoseFrame(ctx, frame, width, height);
  }, [frame, height, width]);

  return <canvas ref={canvasRef} width={width} height={height} className="pose-canvas" />;
}
