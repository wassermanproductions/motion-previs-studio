import type { AnalysisManifest, CameraMotionData, ExportResult, MediaInfo, PlanningData, PoseData } from './types';

declare global {
  interface Window {
    motionPrevis?: {
      openMedia: () => Promise<MediaInfo | null>;
      importUrl: (url: string) => Promise<MediaInfo>;
      prepareAnalysis: (payload: {
        sourcePath: string;
        start: number;
        end: number;
        sampleFps: number;
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
      }) => Promise<ExportResult>;
      openPath: (targetPath: string) => Promise<string>;
      revealPath: (targetPath: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getVersions: () => Promise<Record<string, string>>;
    };
  }
}

export {};
