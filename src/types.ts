export type MediaInfo = {
  filePath: string;
  url: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
};

export type AnalysisManifest = {
  analysisId: string;
  createdAt: string;
  sourcePath: string;
  sourceName: string;
  range: ShotRange;
  sampleFps: number;
  outputDir: string;
  referencePath: string;
  referenceUrl: string;
  depthPath: string;
  depthUrl: string;
  edgesPath?: string;
  edgesUrl?: string;
  lineartPath?: string;
  lineartUrl?: string;
  motionMaskPath?: string;
  motionMaskUrl?: string;
  normalsPath?: string;
  normalsUrl?: string;
  animaticPath?: string;
  animaticUrl?: string;
  contactSheetPath?: string;
  contactSheetUrl?: string;
  previewPath: string;
  previewUrl: string;
  frameSize: { width: number; height: number };
  status: string;
};

export type ShotRange = {
  start: number;
  end: number;
  duration: number;
};

export type Landmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
};

export type PoseModelKey = 'lite' | 'full' | 'heavy';

export type DepthModelKey = 'proxy' | 'depth-anything';

export type PoseAnalysisSettings = {
  poseModel: PoseModelKey;
  depthModel: DepthModelKey;
  detectionConfidence: number;
  trackingConfidence: number;
  smoothing: number;
  temporalWindow: number;
  maxPeople: number;
  fillGaps: boolean;
  optimizeForExport: boolean;
};

export type PosePersonFrame = {
  id: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  score: number;
};

export type PoseFrame = {
  time: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  score: number;
  poses?: PosePersonFrame[];
  source?: 'detected' | 'filled' | 'missing';
  filled?: boolean;
  smoothed?: boolean;
};

export type PoseData = {
  fps: number;
  duration: number;
  width: number;
  height: number;
  frames: PoseFrame[];
  summary: {
    totalFrames?: number;
    detectedFrames: number;
    rawDetectedFrames?: number;
    filledFrames?: number;
    missingFrames?: number;
    lowConfidenceFrames?: number;
    maxPeopleDetected?: number;
    averageScore: number;
    motionEnergy: number;
    settings?: PoseAnalysisSettings;
    runtimeModel?: PoseModelKey;
    runtimeDelegate?: 'GPU' | 'CPU';
    diagnostics?: string[];
  };
};

export type CameraMotionFrame = {
  time: number;
  frameIndex: number;
  imageMotion: {
    xPixels: number;
    yPixels: number;
    scale: number;
    rollRadians: number;
  };
  cameraMove: {
    pan: number;
    tilt: number;
    dollyZoom: number;
    roll: number;
  };
  confidence: number;
};

export type CameraMotionData = {
  fps: number;
  duration: number;
  width: number;
  height: number;
  frames: CameraMotionFrame[];
  summary: {
    panPixels: number;
    tiltPixels: number;
    zoomRatio: number;
    rollDegrees: number;
    averageConfidence: number;
  };
};

// Optional export resolution. 'auto' keeps v3 long-edge scaling; '720p' scales
// control-layer outputs so the SHORT edge is 720 (even dims) for Seedance.
export type ExportResolution = 'auto' | '720p';

export type SubjectMode = 'camera-only' | 'actor-motion' | 'object-motion' | 'full-scene';

export type ExportPreset = 'seedance' | 'comfyui' | 'blender' | 'runway' | 'kling';

export type ControlLayerKey =
  | 'depth'
  | 'ai-depth'
  | 'pose'
  | 'camera'
  | 'edges'
  | 'lineart'
  | 'masks'
  | 'normals'
  | 'motion';

export type ShotBibleEntry = {
  id: string;
  scene: string;
  shot: string;
  description: string;
  duration: number;
  subjectMode: SubjectMode;
  cameraIntent: string;
  selected: boolean;
};

export type QualityReport = {
  score: number;
  tracking: 'Missing' | 'Review' | 'Good' | 'Excellent';
  camera: 'Missing' | 'Review' | 'Good' | 'Excellent';
  layers: 'Missing' | 'Review' | 'Good' | 'Excellent';
  readiness: 'Blocked' | 'Review' | 'Ready';
  notes: string[];
};

export type PlanningData = {
  projectTitle: string;
  sceneTitle: string;
  shotTitle: string;
  creativeIntent: string;
  visualStyle: string;
  subjectMode: SubjectMode;
  selectedLayers: ControlLayerKey[];
  exportPresets: ExportPreset[];
  shotBible: ShotBibleEntry[];
  qualityReport: QualityReport;
  analysisSettings?: PoseAnalysisSettings;
};

export type ExportResult = {
  outputDir: string;
  zipPath: string;
  manifestPath: string;
  files: Record<string, string | null>;
};

// Persisted session written to the workspace so state can be restored on
// relaunch. The renderer sends a ProjectSession; main writes it and returns a
// SavedSession (adds resolved source URL / existence on load).
export type ProjectSession = {
  sourcePath?: string | null;
  sourceName?: string | null;
  range?: { start: number; end: number } | null;
  sampleFps?: number | null;
  subjectMode?: SubjectMode | null;
  poseSettings?: PoseAnalysisSettings | null;
  useCameraMove?: boolean | null;
  selectedLayers?: ControlLayerKey[] | null;
  exportPresets?: ExportPreset[] | null;
  resolution?: ExportResolution | null;
  planning?: {
    projectTitle?: string;
    sceneTitle?: string;
    shotTitle?: string;
    creativeIntent?: string;
    visualStyle?: string;
  } | null;
  lastBundlePath?: string | null;
};

export type SavedSession = ProjectSession & {
  version?: string;
  savedAt?: string;
  sourceUrl?: string;
  sourceExists?: boolean;
};

export type ProgressFn = (progress: number, message: string) => void;

// Cooperative cancellation for the long analysis/encode loops. Callers pass a
// standard AbortSignal; the loops check it between frames and throw an Error
// whose name is 'AbortError' so the app can distinguish a user cancel from a
// real failure.
export const CANCELLED_ERROR_NAME = 'AbortError';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Analysis cancelled.');
    error.name = CANCELLED_ERROR_NAME;
    throw error;
  }
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === CANCELLED_ERROR_NAME;
}
