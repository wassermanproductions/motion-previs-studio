/**
 * The internal imperative control surface that App.tsx publishes on
 * `window.__mps`. The renderer control handler (src/control/handler.ts) reads
 * this surface and dispatches whitelisted agent actions against the SAME code
 * paths the UI uses, so anything an agent does is identical to a human click.
 *
 * App owns all state in hooks; it keeps this object's methods pointed at the
 * latest state/actions via refs, so the handler always sees current values.
 */

import type { SubjectMode } from '../types';

export type ControlAnalysisStatus = 'idle' | 'running' | 'done' | 'error';

export type ControlState = {
  app: string;
  version: string;
  media:
    | {
        name: string;
        duration: number;
        width: number;
        height: number;
      }
    | null;
  range: { startS: number; endS: number };
  referenceMode: SubjectMode;
  settings: {
    sampleFps: number;
    maxPeople: number;
    smoothing: number;
    detectionConfidence: number;
    trackingConfidence: number;
    resolution: 'auto' | '720p';
    depthModel: string;
    poseModel: string;
    useCameraMove: boolean;
  };
  analysis: {
    status: ControlAnalysisStatus;
    stage?: string;
    progress?: number;
    poseFrames?: number;
    detectedFrames?: number;
    cameraConfidence?: number;
    qualityScore?: number;
  };
  lastBundlePath?: string | null;
  blockoutAvailable: boolean;
  conventions: string;
};

export type ControlSettingsPatch = {
  sampleFps?: number;
  maxPeople?: number;
  smoothing?: number;
  detectionConfidence?: number;
  trackingConfidence?: number;
  resolution?: 'auto' | '720p';
};

export type SendToBlockoutWhich = 'reference' | 'depth' | 'ai_depth' | 'pose' | 'openpose';

export interface MpsControlSurface {
  getState(): ControlState;
  importFile(path: string): Promise<{ name: string; duration: number; width: number; height: number }>;
  importUrl(url: string): Promise<{ name: string; duration: number; width: number; height: number }>;
  setRange(startS: number, endS: number): { startS: number; endS: number };
  setMode(mode: SubjectMode): { referenceMode: SubjectMode };
  setSettings(patch: ControlSettingsPatch): ControlState['settings'];
  runAnalysis(): { started: true };
  exportPack(): Promise<{ bundlePath: string; zipPath: string }>;
  listBundle(): Promise<{ bundlePath: string; files: string[] }>;
  sendToBlockout(which: SendToBlockoutWhich): Promise<{ ok: true; which: SendToBlockoutWhich; videoPath: string; handoffVersion: number }>;
}
