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

export type PoseFrame = {
  time: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  score: number;
};

export type PoseData = {
  fps: number;
  duration: number;
  width: number;
  height: number;
  frames: PoseFrame[];
  summary: {
    detectedFrames: number;
    averageScore: number;
    motionEnergy: number;
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
};

export type ExportResult = {
  outputDir: string;
  zipPath: string;
  manifestPath: string;
  files: Record<string, string | null>;
};

export type ProgressFn = (progress: number, message: string) => void;
