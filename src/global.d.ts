import type {
  AnalysisManifest,
  CameraMotionData,
  ExportResolution,
  ExportResult,
  MediaInfo,
  PlanningData,
  PoseData,
  ProjectSession,
  SavedSession
} from './types';

declare global {
  interface Window {
    motionPrevis?: {
      openMedia: () => Promise<MediaInfo | null>;
      importPath: (sourcePath: string) => Promise<MediaInfo>;
      importUrl: (url: string) => Promise<MediaInfo>;
      prepareAnalysis: (payload: {
        sourcePath: string;
        start: number;
        end: number;
        sampleFps: number;
        resolution?: ExportResolution;
      }) => Promise<AnalysisManifest>;
      savePoseArtifacts: (payload: {
        outputDir: string;
        referencePath: string;
        depthPath: string;
        edgesPath?: string;
        lineartPath?: string;
        motionMaskPath?: string;
        normalsPath?: string;
        contactSheetPath?: string;
        animaticPath?: string;
        sourceName: string;
        range: { start: number; end: number; duration: number };
        sampleFps: number;
        poseData: PoseData;
        cameraMotionData?: CameraMotionData;
        planningData?: PlanningData;
        poseVideoBuffer: ArrayBuffer;
        aiDepthVideoBuffer?: ArrayBuffer;
        openPoseVideoBuffer?: ArrayBuffer;
        openPoseKeypoints?: unknown;
        resolution?: ExportResolution;
      }) => Promise<ExportResult>;
      encodeFramesBegin: (payload: { fps: number; width: number; height: number }) => Promise<{ sessionId: string }>;
      encodeFramesFrame: (payload: { sessionId: string; buffer: ArrayBuffer }) => Promise<{ frames: number }>;
      encodeFramesEnd: (payload: { sessionId: string }) => Promise<{ buffer: ArrayBuffer; frames: number }>;
      openPath: (targetPath: string) => Promise<string>;
      revealPath: (targetPath: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getVersions: () => Promise<Record<string, string>>;
      saveSession: (session: ProjectSession) => Promise<{ saved: boolean; path: string }>;
      loadSession: () => Promise<SavedSession | null>;
      sendToBlockout: (payload: {
        videoPath: string;
        mode?: 'ghost' | 'pip';
        opacity?: number;
      }) => Promise<{ ok: boolean; mode: string; opacity: number; result?: unknown }>;
      blockoutStatus: () => Promise<{ available: boolean }>;
      onControlInvoke: (
        cb: (id: string, action: string, params: unknown) => void
      ) => () => void;
      controlResult: (id: string, result: { ok: boolean; data?: unknown; error?: string }) => void;
    };
    __mps?: import('./control/registry').MpsControlSurface;
  }
}

export {};
