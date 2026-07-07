import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Box,
  Camera,
  CheckCircle2,
  Clapperboard,
  Cpu,
  Download,
  FileArchive,
  FileVideo,
  FolderOpen,
  Gauge,
  HelpCircle,
  Image as ImageIcon,
  Info,
  Layers3,
  Link,
  Maximize2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  Send,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  SquareStack,
  Upload,
  X,
  Youtube
} from 'lucide-react';
import type {
  AnalysisManifest,
  CameraMotionData,
  ControlLayerKey,
  ExportPreset,
  ExportResolution,
  ExportResult,
  MediaInfo,
  PlanningData,
  PoseAnalysisSettings,
  PoseData,
  PoseFrame,
  PoseModelKey,
  ProjectSession,
  SavedSession,
  SubjectMode
} from './types';
import { isCancelledError } from './types';
import { createAiDepthVideoBlob } from './lib/aiDepth';
import { analyzeCameraMotionVideo } from './lib/cameraMotion';
import { buildOpenPoseJson, renderOpenPoseFrames } from './lib/openpose';
import {
  DEFAULT_POSE_SETTINGS,
  DEPTH_MODEL_OPTIONS,
  POSE_CONNECTIONS,
  POSE_MODEL_OPTIONS,
  analyzePoseVideo,
  poseConnectionColor
} from './lib/pose';
import { createPoseVideoBlob } from './lib/poseVideo';
import { computeQualityReport, layerScore, trackingScore } from './lib/quality';
import { ThreePreview } from './components/ThreePreview';
import logoUrl from './assets/logo.png';

type Stage = 'idle' | 'importing' | 'preparing' | 'tracking' | 'ready' | 'exporting' | 'exported' | 'error';

// The five real analysis/export stages surfaced in the progress rail. Each maps
// to callbacks that already exist in the lib layer.
type StageKey = 'prepare' | 'pose' | 'camera' | 'encode' | 'bundle';
const STAGE_STEPS: { key: StageKey; label: string }[] = [
  { key: 'prepare', label: 'Prepare' },
  { key: 'pose', label: 'Pose' },
  { key: 'camera', label: 'Camera' },
  { key: 'encode', label: 'Encode' },
  { key: 'bundle', label: 'Bundle' }
];

const CONTROL_LAYERS: { key: ControlLayerKey; label: string }[] = [
  { key: 'depth', label: 'Depth' },
  { key: 'ai-depth', label: 'AI depth' },
  { key: 'pose', label: 'Pose' },
  { key: 'camera', label: 'Camera' },
  { key: 'edges', label: 'Edges' },
  { key: 'lineart', label: 'Lineart' },
  { key: 'masks', label: 'Masks' },
  { key: 'normals', label: 'Normals' }
];

const EXPORT_PRESETS: { key: ExportPreset; label: string }[] = [
  { key: 'seedance', label: 'Seedance' },
  { key: 'comfyui', label: 'ComfyUI' },
  { key: 'blender', label: 'Blender' },
  { key: 'runway', label: 'Runway' },
  { key: 'kling', label: 'Kling' }
];

const WORKFLOW_STEPS = ['Shot', 'Analyze', 'Plan', 'Export'];

// The single Reference Mode control: four explicit options, each with a one-line
// explainer, mapping straight onto the subjectMode state.
const REFERENCE_MODES: { key: SubjectMode; label: string; hint: string }[] = [
  { key: 'camera-only', label: 'Camera only', hint: 'Keep just the camera move and timing. Replace the subject and world.' },
  { key: 'actor-motion', label: 'Actor motion', hint: 'Preserve body/pose motion plus the camera move.' },
  { key: 'object-motion', label: 'Object motion', hint: 'Preserve an object or vehicle path plus the camera move.' },
  { key: 'full-scene', label: 'Full scene', hint: 'Preserve camera, blocking, subject motion, and depth rhythm.' }
];

const PRESET_ACCENTS: Record<ExportPreset, string> = {
  seedance: '#3ee3d2',
  comfyui: '#9e7cff',
  blender: '#ff932e',
  runway: '#47e571',
  kling: '#45c8ff'
};

const CREDIT_LINE = 'Created by Sam Wasserman · wassermanproductions.com · wasserman.ai · Apache-2.0';

type Toast = { id: number; text: string; tone: 'ok' | 'error' };

export function App() {
  const [source, setSource] = useState<MediaInfo | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisManifest | null>(null);
  const [poseData, setPoseData] = useState<PoseData | null>(null);
  const [cameraMotionData, setCameraMotionData] = useState<CameraMotionData | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState('');
  const [range, setRange] = useState({ start: 0, end: 8 });
  const [sampleFps, setSampleFps] = useState(12);
  const [resolution, setResolution] = useState<ExportResolution>('auto');
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [activeStage, setActiveStage] = useState<StageKey | null>(null);
  const [message, setMessage] = useState('Import a clip or paste a web video URL to begin.');
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [poseSettings, setPoseSettings] = useState<PoseAnalysisSettings>(DEFAULT_POSE_SETTINGS);
  const [useCameraMove, setUseCameraMove] = useState(true);
  const [projectTitle, setProjectTitle] = useState('Motion Previs Project');
  const [sceneTitle, setSceneTitle] = useState('Scene 01');
  const [shotTitle, setShotTitle] = useState('Shot 01A');
  const [creativeIntent, setCreativeIntent] = useState('Preserve the reference camera move and timing while allowing new subject design.');
  const [visualStyle, setVisualStyle] = useState('Cinematic AI-film previs with clean blocking, controlled depth, and professional continuity.');
  const [subjectMode, setSubjectMode] = useState<SubjectMode>('camera-only');
  const [selectedLayers, setSelectedLayers] = useState<ControlLayerKey[]>(['depth', 'ai-depth', 'pose', 'camera', 'edges', 'masks']);
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>(['seedance', 'comfyui', 'blender']);
  const [showHelp, setShowHelp] = useState(false);
  const [blockoutAvailable, setBlockoutAvailable] = useState(false);
  const [restorePrompt, setRestorePrompt] = useState<SavedSession | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const referenceVideoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toastId = useRef(0);
  // Guards a one-time settings restore so a load doesn't fight fresh edits.
  const restoredRef = useRef(false);

  useEffect(() => {
    window.motionPrevis?.getVersions().then(setVersions).catch(() => undefined);
  }, []);

  // Offer to restore the last session on launch.
  useEffect(() => {
    let cancelled = false;
    window.motionPrevis
      ?.loadSession()
      .then((session) => {
        if (cancelled || !session) return;
        // Always restore settings silently; only prompt to restore media when a
        // real source file is still on disk.
        applySessionSettings(session);
        if (session.sourceExists && session.sourcePath) {
          setRestorePrompt(session);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll whether Blockout is reachable so the Send button reflects reality.
  useEffect(() => {
    let alive = true;
    const check = () => {
      window.motionPrevis
        ?.blockoutStatus()
        .then((status) => {
          if (alive) setBlockoutAvailable(Boolean(status?.available));
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const duration = source?.duration || 0;
  const selectedDuration = Math.max(0.1, range.end - range.start);
  const useAiDepth = poseSettings.depthModel === 'depth-anything';
  const currentPoseFrame = useMemo(() => selectPoseFrame(poseData, currentTime), [currentTime, poseData]);

  const qualityReport = useMemo(() => {
    const totalFrames = poseData?.frames.length || 0;
    const rawDetected = poseData?.summary.rawDetectedFrames ?? poseData?.summary.detectedFrames ?? 0;
    const filled = poseData?.summary.filledFrames || 0;
    const tracking = trackingScore(rawDetected, filled, totalFrames);
    const camera = useCameraMove ? cameraMotionData?.summary.averageConfidence || 0 : 0;
    const layers = analysis ? layerScore(selectedLayers.length) : 0;
    return computeQualityReport({
      tracking,
      camera,
      layers,
      cameraActive: useCameraMove,
      rawDetectedFrames: rawDetected,
      totalFrames,
      filledFrames: filled
    });
  }, [analysis, cameraMotionData, poseData, selectedLayers, useCameraMove]);

  const planningData = useMemo<PlanningData>(
    () => ({
      projectTitle: projectTitle.trim() || 'Motion Previs Project',
      sceneTitle: sceneTitle.trim() || 'Scene 01',
      shotTitle: shotTitle.trim() || 'Shot 01A',
      creativeIntent: creativeIntent.trim() || 'Preserve reference timing and camera language for a new AI-film shot.',
      visualStyle: visualStyle.trim() || 'Professional cinematic previs.',
      subjectMode,
      selectedLayers,
      exportPresets,
      shotBible: [
        {
          id: 'shot-001',
          scene: sceneTitle.trim() || 'Scene 01',
          shot: shotTitle.trim() || 'Shot 01A',
          description: creativeIntent.trim() || 'Reference-derived previs shot.',
          duration: selectedDuration,
          subjectMode,
          cameraIntent: useCameraMove
            ? 'Recreate the solved camera pan, tilt, zoom, roll, and timing from the reference.'
            : 'Camera solve disabled for this pass.',
          selected: true
        }
      ],
      qualityReport,
      analysisSettings: poseSettings
    }),
    [creativeIntent, exportPresets, projectTitle, qualityReport, sceneTitle, selectedDuration, selectedLayers, shotTitle, subjectMode, useCameraMove, visualStyle, poseSettings]
  );

  function pushToast(text: string, tone: 'ok' | 'error' = 'ok') {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }

  function applySessionSettings(session: SavedSession | ProjectSession) {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (session.range) setRange({ start: session.range.start, end: session.range.end });
    if (typeof session.sampleFps === 'number') setSampleFps(session.sampleFps);
    if (session.subjectMode) setSubjectMode(session.subjectMode);
    if (session.poseSettings) setPoseSettings((current) => ({ ...current, ...session.poseSettings }));
    if (typeof session.useCameraMove === 'boolean') setUseCameraMove(session.useCameraMove);
    if (session.selectedLayers?.length) setSelectedLayers(session.selectedLayers);
    if (session.exportPresets?.length) setExportPresets(session.exportPresets);
    if (session.resolution) setResolution(session.resolution);
    if (session.planning?.projectTitle) setProjectTitle(session.planning.projectTitle);
    if (session.planning?.sceneTitle) setSceneTitle(session.planning.sceneTitle);
    if (session.planning?.shotTitle) setShotTitle(session.planning.shotTitle);
    if (session.planning?.creativeIntent) setCreativeIntent(session.planning.creativeIntent);
    if (session.planning?.visualStyle) setVisualStyle(session.planning.visualStyle);
  }

  const buildSession = useCallback((): ProjectSession => ({
    sourcePath: source?.filePath ?? null,
    sourceName: source?.name ?? null,
    range: { start: range.start, end: range.end },
    sampleFps,
    subjectMode,
    poseSettings,
    useCameraMove,
    selectedLayers,
    exportPresets,
    resolution,
    planning: {
      projectTitle,
      sceneTitle,
      shotTitle,
      creativeIntent,
      visualStyle
    },
    lastBundlePath: exportResult?.outputDir ?? null
  }), [source, range, sampleFps, subjectMode, poseSettings, useCameraMove, selectedLayers, exportPresets, resolution, projectTitle, sceneTitle, shotTitle, creativeIntent, visualStyle, exportResult]);

  async function saveProject() {
    try {
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      await window.motionPrevis.saveSession(buildSession());
      pushToast('Project saved.');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  // Persist settings quietly whenever they change (so restarts keep them) once a
  // source is loaded — avoids clobbering the on-disk session before restore.
  useEffect(() => {
    if (!restoredRef.current) return;
    const timer = window.setTimeout(() => {
      window.motionPrevis?.saveSession(buildSession()).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [buildSession]);

  async function restoreLastSession() {
    const session = restorePrompt;
    setRestorePrompt(null);
    if (!session?.sourcePath || !session.sourceUrl) return;
    // Re-probe the file through the bridge so we get fresh metadata + URL.
    try {
      setStage('importing');
      setMessage('Restoring last project');
      // The main process already re-allowed the path; build a MediaInfo shell
      // and let prepareAnalysis re-probe on demand.
      const media: MediaInfo = {
        filePath: session.sourcePath,
        url: session.sourceUrl,
        name: session.sourceName || session.sourcePath.split('/').pop() || 'Clip',
        duration: session.range ? Math.max(session.range.end, 8) : 8,
        width: 0,
        height: 0,
        frameRate: 0,
        videoCodec: 'unknown',
        audioCodec: null,
        sizeBytes: 0
      };
      setSource(media);
      if (session.range) setRange({ start: session.range.start, end: session.range.end });
      setStage('idle');
      setMessage('Restored last project. Run analysis when ready.');
      pushToast('Last project restored.');
    } catch (err) {
      fail(err);
    }
  }

  async function loadFile() {
    try {
      setStage('importing');
      setMessage('Opening media file');
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      const media = await window.motionPrevis.openMedia();
      if (!media) {
        setStage('idle');
        return;
      }
      acceptSource(media);
    } catch (err) {
      fail(err);
    }
  }

  async function loadUrl() {
    try {
      setStage('importing');
      setProgress(0.05);
      setMessage('Downloading web video with yt-dlp');
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      const media = await window.motionPrevis.importUrl(url.trim());
      acceptSource(media);
    } catch (err) {
      fail(err);
    }
  }

  function acceptSource(media: MediaInfo) {
    setSource(media);
    setAnalysis(null);
    setPoseData(null);
    setCameraMotionData(null);
    setExportResult(null);
    setError('');
    setProgress(0);
    setActiveStage(null);
    const end = Math.min(media.duration || 8, 8);
    setRange({ start: 0, end: Math.max(0.1, end) });
    setShotTitle(toShotTitle(media.name));
    setStage('idle');
    setMessage('Choose the shot range and run analysis.');
    restoredRef.current = true; // enable session autosave now that media exists
    window.motionPrevis?.saveSession(buildSession()).catch(() => undefined);
  }

  function reportStage(key: StageKey, fraction: number, text: string) {
    setActiveStage(key);
    setProgress(clamp(fraction, 0, 1));
    setMessage(text);
  }

  async function runAnalysis() {
    if (!source) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setError('');
      setExportResult(null);
      setStage('preparing');
      reportStage('prepare', 0.04, 'Preparing trimmed reference and control passes');
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      const prepared = await window.motionPrevis.prepareAnalysis({
        sourcePath: source.filePath,
        start: range.start,
        end: range.end,
        sampleFps,
        resolution
      });
      throwIfCancelled(controller.signal);
      setAnalysis(prepared);
      setStage('tracking');
      reportStage('pose', 0.18, 'Tracking pose');
      const pose = await analyzePoseVideo(
        prepared.referenceUrl,
        sampleFps,
        poseSettings,
        (nextProgress, nextMessage) => reportStage('pose', nextProgress, nextMessage),
        controller.signal
      );
      setPoseData(pose);
      if (useCameraMove) {
        reportStage('camera', 0.8, 'Solving subject-masked camera move');
        const cameraMove = await analyzeCameraMotionVideo(
          prepared.referenceUrl,
          Math.min(sampleFps, 12),
          pose,
          (nextProgress, nextMessage) => reportStage('camera', nextProgress, nextMessage),
          controller.signal
        );
        setCameraMotionData(cameraMove);
      } else {
        setCameraMotionData(null);
      }
      throwIfCancelled(controller.signal);
      setCurrentTime(0);
      setStage('ready');
      setActiveStage(null);
      setProgress(0.82);
      setMessage(
        `Analysis complete. Pose ${pose.summary.detectedFrames}/${pose.frames.length} frames, ${pose.summary.filledFrames || 0} filled gaps.`
      );
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      abortRef.current = null;
    }
  }

  async function exportBundle() {
    if (!analysis || !poseData) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const w = analysis.frameSize.width || 1280;
    const h = analysis.frameSize.height || 720;
    try {
      setStage('exporting');
      reportStage('encode', 0.82, 'Rendering high-contrast pose video');
      const poseVideo = await createPoseVideoBlob(
        poseData,
        w,
        h,
        (nextProgress, nextMessage) => reportStage('encode', nextProgress, nextMessage),
        controller.signal
      );
      const buffer = await poseVideo.arrayBuffer();

      // Phase-2 OpenPose/BODY_25 export (deterministic render + keypoints JSON).
      reportStage('encode', 0.9, 'Rendering OpenPose BODY_25 skeleton');
      const openPoseBlob = await renderOpenPoseFrames(
        poseData,
        w,
        h,
        (nextProgress, nextMessage) => reportStage('encode', nextProgress, nextMessage),
        controller.signal
      );
      const openPoseVideoBuffer = await openPoseBlob.arrayBuffer();
      const openPoseKeypoints = buildOpenPoseJson(poseData, w, h);

      let aiDepthVideoBuffer: ArrayBuffer | undefined;
      if (useAiDepth) {
        try {
          reportStage('encode', 0.95, 'Rendering AI Depth Anything pass');
          const aiDepthVideo = await createAiDepthVideoBlob(
            analysis.referenceUrl,
            Math.min(sampleFps, 8),
            w,
            h,
            (nextProgress, nextMessage) => reportStage('encode', nextProgress, nextMessage),
            controller.signal
          );
          aiDepthVideoBuffer = await aiDepthVideo.arrayBuffer();
        } catch (depthError) {
          if (isCancelledError(depthError)) throw depthError;
          console.warn(depthError);
          setMessage('AI depth unavailable; exporting fast depth proxy.');
        }
      }

      throwIfCancelled(controller.signal);
      reportStage('bundle', 0.97, 'Saving export bundle');
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      const saved = await window.motionPrevis.savePoseArtifacts({
        outputDir: analysis.outputDir,
        referencePath: analysis.referencePath,
        depthPath: analysis.depthPath,
        edgesPath: analysis.edgesPath,
        lineartPath: analysis.lineartPath,
        motionMaskPath: analysis.motionMaskPath,
        normalsPath: analysis.normalsPath,
        contactSheetPath: analysis.contactSheetPath,
        animaticPath: analysis.animaticPath,
        sourceName: analysis.sourceName,
        range: analysis.range,
        sampleFps,
        poseData,
        cameraMotionData: cameraMotionData || undefined,
        planningData,
        poseVideoBuffer: buffer,
        aiDepthVideoBuffer,
        openPoseVideoBuffer,
        openPoseKeypoints,
        resolution
      });
      setExportResult(saved);
      setProgress(1);
      setActiveStage(null);
      setStage('exported');
      setMessage('Export bundle is ready.');
      window.motionPrevis?.saveSession({ ...buildSession(), lastBundlePath: saved.outputDir }).catch(() => undefined);
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      abortRef.current = null;
    }
  }

  function cancelAnalysis() {
    abortRef.current?.abort();
    setMessage('Cancelling…');
  }

  function handleAnalysisError(err: unknown) {
    if (isCancelledError(err)) {
      setStage(analysis && poseData ? 'ready' : 'idle');
      setActiveStage(null);
      setProgress(analysis && poseData ? 0.82 : 0);
      setError('');
      setMessage('Cancelled. The app is ready for the next run.');
      pushToast('Analysis cancelled.');
      return;
    }
    fail(err);
  }

  function fail(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    setError(text);
    setMessage(text);
    setStage('error');
    setActiveStage(null);
    setProgress(0);
  }

  async function sendToBlockout(kind: 'reference' | 'depth') {
    if (!exportResult) return;
    const files = exportResult.files;
    const referencePath = typeof files.reference === 'string' ? files.reference : null;
    const depthPath = (typeof files.aiDepthMp4 === 'string' && files.aiDepthMp4) || (typeof files.depth === 'string' ? files.depth : null);
    const videoPath = kind === 'depth' ? depthPath : referencePath;
    if (!videoPath) {
      pushToast(`No ${kind} video available to send.`, 'error');
      return;
    }
    try {
      pushToast(`Sending ${kind} to Blockout…`);
      const result = await window.motionPrevis?.sendToBlockout({ videoPath, mode: 'ghost', opacity: 0.5 });
      if (result?.ok) pushToast(`Sent ${kind} to Blockout as a ghost reference.`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function updateStart(value: number) {
    const next = clamp(value, 0, Math.max(0, range.end - 0.1));
    setRange((current) => ({ ...current, start: next }));
  }

  function updateEnd(value: number) {
    const next = clamp(value, range.start + 0.1, Math.max(range.start + 0.1, duration));
    setRange((current) => ({ ...current, end: next }));
  }

  function updatePoseSetting<K extends keyof PoseAnalysisSettings>(key: K, value: PoseAnalysisSettings[K]) {
    setPoseSettings((current) => ({ ...current, [key]: value }));
  }

  function stepPoseSetting(key: 'temporalWindow' | 'maxPeople', delta: number) {
    setPoseSettings((current) => ({
      ...current,
      [key]: key === 'maxPeople' ? clamp(current[key] + delta, 1, 4) : clamp(current[key] + delta, 1, 30)
    }));
  }

  function toggleLayer(key: ControlLayerKey) {
    setSelectedLayers((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((item) => item !== key);
      }
      return [...current, key];
    });
  }

  function togglePreset(key: ExportPreset) {
    setExportPresets((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((item) => item !== key);
      }
      return [...current, key];
    });
  }

  // Transport wiring — the reference <video> is the single source of playback.
  function withVideo(fn: (video: HTMLVideoElement) => void) {
    const video = referenceVideoRef.current;
    if (video) fn(video);
  }
  const playPause = () => withVideo((video) => (video.paused ? video.play() : video.pause()));
  const stepBack = () => withVideo((video) => (video.currentTime = Math.max(0, video.currentTime - 1 / Math.max(sampleFps, 1))));
  const stepForward = () =>
    withVideo((video) => (video.currentTime = Math.min(video.duration || video.currentTime + 1, video.currentTime + 1 / Math.max(sampleFps, 1))));
  const skipStart = () => withVideo((video) => (video.currentTime = 0));
  const skipEnd = () => withVideo((video) => (video.currentTime = video.duration || video.currentTime));

  const activeWorkflowStep = workflowStepForStage(stage);
  const previewUrl = analysis?.referenceUrl || source?.url || '';
  const previewPoster = analysis?.previewUrl;
  const sourceName = analysis?.sourceName || source?.name || 'No source loaded';
  const durationLabel = source && source.duration ? formatTime(source.duration) : '--';
  const selectedDurationLabel = `${Math.round(selectedDuration)}s`;
  const frameRateLabel = source?.frameRate
    ? `${source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps`
    : `${sampleFps} fps`;
  const resolutionLabel = source && source.width ? `${source.width} x ${source.height}` : '--';
  const qualityStatus = stage === 'exported' ? 'Ready to share' : stage === 'ready' ? 'Ready to export' : qualityReport.readiness;
  const poseModelName = POSE_MODEL_OPTIONS.find((option) => option.key === poseSettings.poseModel)?.label.replace('MediaPipe Pose ', '') || 'Pose';
  const busy = isBusy(stage);
  const activeReferenceMode = REFERENCE_MODES.find((mode) => mode.key === subjectMode) || REFERENCE_MODES[0];

  return (
    <main className="app-shell">
      <header className="top-chrome">
        <div className="brand-mark" aria-hidden="true">
          <img src={logoUrl} alt="" className="brand-logo-sm" />
        </div>
        <div className="top-title">
          <h1>Motion Previs Studio v4</h1>
          <p>Created by Sam Wasserman</p>
          <div className="brand-links" aria-label="Wasserman links">
            <ExternalLinkButton url="https://wassermanproductions.com">WassermanProductions.com</ExternalLinkButton>
            <ExternalLinkButton url="https://wasserman.ai">Wasserman.ai</ExternalLinkButton>
          </div>
        </div>
        <WorkflowStepper activeStep={activeWorkflowStep} />
        <div className="top-actions" aria-label="Application tools">
          <IconButton label="Open source" onClick={loadFile} disabled={busy}>
            <FolderOpen size={18} />
          </IconButton>
          <IconButton label="Save project" onClick={saveProject} disabled={!source}>
            <Save size={18} />
          </IconButton>
          <IconButton label="Settings">
            <Settings2 size={18} />
          </IconButton>
          <IconButton label="Help" onClick={() => setShowHelp(true)}>
            <HelpCircle size={18} />
          </IconButton>
        </div>
      </header>

      <div className="studio-shell">
      <aside className="sidebar left-sidebar">
        <section className="panel source-panel">
          <div className="panel-title">
            <FileVideo size={16} />
            <span>Source</span>
          </div>
          <div className="import-grid">
            <button className="secondary-action" onClick={loadFile} disabled={busy}>
              <Upload size={16} />
              Import
            </button>
            <button className="secondary-action" onClick={loadUrl} disabled={!url.trim() || busy}>
              <Youtube size={16} />
              Web video
            </button>
          </div>
          <div className="url-row">
            <Link size={15} />
            <input
              value={url}
              placeholder="Paste YouTube or video URL"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && url.trim()) loadUrl();
              }}
            />
          </div>
          {source ? (
            <div className="source-card">
              <ShotThumb previewUrl={previewUrl} poster={previewPoster} />
              <div>
                <strong>{source.name}</strong>
                <span>
                  {source.width ? `${source.width}x${source.height} · ` : ''}
                  {frameRateLabel}
                  {source.videoCodec && source.videoCodec !== 'unknown' ? ` · ${source.videoCodec}` : ''}
                </span>
              </div>
              <CheckCircle2 size={16} />
            </div>
          ) : (
            <div className="empty-note">MP4, MOV, MKV, WebM, direct URLs, and YouTube-compatible links.</div>
          )}
        </section>

        <section className="panel project-panel">
          <div className="panel-title">
            <SquareStack size={16} />
            <span>Shot Plan</span>
          </div>
          <label className="control-label">
            Project
            <input className="text-field" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} disabled={busy} />
          </label>
          <div className="split-fields">
            <label className="control-label">
              Scene
              <input className="text-field" value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} disabled={busy} />
            </label>
            <label className="control-label">
              Shot
              <input className="text-field" value={shotTitle} onChange={(event) => setShotTitle(event.target.value)} disabled={busy} />
            </label>
          </div>
          <label className="control-label">
            Intent
            <textarea className="textarea-field" value={creativeIntent} onChange={(event) => setCreativeIntent(event.target.value)} disabled={busy} rows={2} />
          </label>
        </section>

        <section className="panel project-panel">
          <div className="panel-title">
            <Info size={16} />
            <span>Project Info</span>
          </div>
          <InfoRow label="Resolution" value={resolutionLabel} />
          <InfoRow label="Frame Rate" value={frameRateLabel} />
          <InfoRow label="Duration" value={durationLabel} />
          <InfoRow label="Date" value={formatDisplayDate(analysis?.createdAt)} />
        </section>

        <section className="panel range-panel">
          <div className="panel-title">
            <Scissors size={16} />
            <span>Shot Range</span>
          </div>
          <div className="range-readout">
            <strong>{formatTime(range.start)}</strong>
            <span>{formatTime(selectedDuration)}</span>
            <strong>{formatTime(range.end)}</strong>
          </div>
          <label className="control-label">
            Start
            <input
              type="range"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={range.start}
              onChange={(event) => updateStart(Number(event.target.value))}
              disabled={!source || busy}
            />
          </label>
          <label className="control-label">
            End
            <input
              type="range"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={range.end}
              onChange={(event) => updateEnd(Number(event.target.value))}
              disabled={!source || busy}
            />
          </label>
          <div className="time-inputs">
            <input value={range.start.toFixed(2)} onChange={(event) => updateStart(Number(event.target.value))} />
            <input value={range.end.toFixed(2)} onChange={(event) => updateEnd(Number(event.target.value))} />
          </div>
        </section>

        <section className="panel status-panel">
          <div className="panel-title">
            <Activity size={16} />
            <span>Analyze</span>
          </div>
          {busy ? (
            <button className="primary-action cancel-action" onClick={cancelAnalysis}>
              <Square size={15} />
              Cancel
            </button>
          ) : (
            <button className="primary-action" onClick={runAnalysis} disabled={!source}>
              <Play size={17} />
              Run Analysis
            </button>
          )}
          <StageRail steps={STAGE_STEPS} activeStage={activeStage} stage={stage} />
          <div className="progress-track">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className={error ? 'status-text error' : 'status-text'}>{message}</p>
        </section>
      </aside>

      <section className="workspace">
        {!source ? (
          <WelcomeState onImport={loadFile} onHelp={() => setShowHelp(true)} />
        ) : (
          <>
            <div className="workspace-toolbar">
              <div className="shot-context">
                <strong>{shotTitle || 'Shot 01A'}</strong>
                <span>{sourceName}</span>
              </div>
              <div className="timecode">
                {formatTime(currentTime)} / {formatTime(selectedDuration)}
              </div>
              <div className="view-tools">
                <button type="button">Fit</button>
                <IconButton label="Frame view">
                  <Maximize2 size={16} />
                </IconButton>
              </div>
            </div>

            <div className="preview-grid">
              <PreviewPane title="Reference" tone="reference-main">
                {analysis ? (
                  <video
                    ref={referenceVideoRef}
                    src={analysis.referenceUrl}
                    poster={analysis.previewUrl}
                    controls
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  />
                ) : (
                  <video
                    ref={referenceVideoRef}
                    src={source.url}
                    controls
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  />
                )}
              </PreviewPane>

              <PreviewPane title="Camera Path" tone="camera-main">
                <CameraPathPreview videoUrl={previewUrl} poster={previewPoster} cameraMotionData={cameraMotionData} />
              </PreviewPane>

              <PreviewPane title="Pose (2D Skeleton)" tone="pose-actor">
                <PoseOverlayPreview
                  frame={currentPoseFrame}
                  videoUrl={previewUrl}
                  poster={previewPoster}
                  width={analysis?.frameSize.width || source?.width || 1280}
                  height={analysis?.frameSize.height || source?.height || 720}
                />
              </PreviewPane>

              <PreviewPane title="Depth" tone="depth-mini">
                <LayerVideo url={analysis?.depthUrl} poster={analysis?.previewUrl} label="Depth map appears after analysis" />
              </PreviewPane>

              <PreviewPane title="Edges" tone="edges-mini">
                <LayerVideo url={analysis?.edgesUrl || analysis?.lineartUrl} label="Edge map appears after analysis" />
              </PreviewPane>

              <PreviewPane title="Masks" tone="masks-mini">
                <LayerVideo url={analysis?.motionMaskUrl} label="Motion mask appears after analysis" />
              </PreviewPane>

              <PreviewPane title="3D Stick Figure" tone="pose-all">
                <PoseAllPreview frame={currentPoseFrame} poseData={poseData} />
              </PreviewPane>
            </div>

            <TransportBar
              sampleFps={sampleFps}
              isPlaying={isPlaying}
              onPlayPause={playPause}
              onStepBack={stepBack}
              onStepForward={stepForward}
              onSkipStart={skipStart}
              onSkipEnd={skipEnd}
              disabled={!analysis && !source}
            />

            <div className="timeline">
              <div className="timeline-head">
                <span>{shotTitle || 'Shot 01A'}</span>
                <strong>{selectedDurationLabel}</strong>
              </div>
              <div className="timeline-track">
                <TimelineFilmstrip previewUrl={previewUrl} poster={previewPoster} />
                <div
                  className="timeline-selection"
                  style={{
                    left: `${duration ? (range.start / duration) * 100 : 0}%`,
                    width: `${duration ? ((range.end - range.start) / duration) * 100 : 0}%`
                  }}
                />
                <div className="timeline-playhead" style={{ left: `${selectedDuration ? (currentTime / selectedDuration) * 100 : 50}%` }} />
                {poseData?.frames.map((frame, index) => (
                  <span
                    key={`${frame.time}-${index}`}
                    className={frame.filled ? 'pose-tick filled' : frame.landmarks.length ? 'pose-tick detected' : 'pose-tick'}
                    style={{ left: `${(index / Math.max(poseData.frames.length - 1, 1)) * 100}%` }}
                  />
                ))}
              </div>
            </div>

            <div className="analysis-dock">
              <StatusItem icon={<CheckCircle2 size={18} />} label="Analysis Status" value={stage === 'ready' || stage === 'exported' ? 'Ready' : stage} />
              <StatusItem icon={<BrainGlyph />} label="Model" value={`${poseModelName} + ${useAiDepth ? 'AI Depth' : 'Proxy Depth'}`} />
              <StatusItem icon={<Cpu size={18} />} label="Runtime" value={poseData?.summary.runtimeDelegate ? `${poseData.summary.runtimeDelegate}` : useAiDepth ? 'WebGPU/CPU' : 'CPU'} />
              <StatusItem icon={<Monitor size={18} />} label="Resolution" value={resolutionLabel} />
              <StatusItem icon={<Clapperboard size={18} />} label="FPS" value={frameRateLabel} />
            </div>
          </>
        )}
      </section>

      <aside className="sidebar right-sidebar">
        <section className="panel reference-mode-panel">
          <div className="panel-heading">
            <h2>Reference Mode</h2>
            <span className="status-pill green">{activeReferenceMode.label}</span>
          </div>
          <div className="reference-mode-segment" role="radiogroup" aria-label="Reference mode">
            {REFERENCE_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                role="radio"
                aria-checked={subjectMode === mode.key}
                className={subjectMode === mode.key ? 'reference-mode-option active' : 'reference-mode-option'}
                onClick={() => setSubjectMode(mode.key)}
                disabled={busy}
              >
                <strong>{mode.label}</strong>
                <em>{mode.hint}</em>
              </button>
            ))}
          </div>
          <label className="control-label">
            Style
            <textarea className="textarea-field compact" value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} disabled={busy} rows={2} />
          </label>
        </section>

        <section className="panel analyze-panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <span>Analysis Settings</span>
          </div>
          <SettingSelect
            label="Pose Model"
            value={poseSettings.poseModel}
            options={POSE_MODEL_OPTIONS.map((option) => ({ value: option.key, label: option.label, title: option.detail }))}
            onChange={(value) => updatePoseSetting('poseModel', value as PoseModelKey)}
            disabled={busy}
          />
          <SettingSelect
            label="Depth Model"
            value={poseSettings.depthModel}
            options={DEPTH_MODEL_OPTIONS.map((option) => ({ value: option.key, label: option.label, title: option.detail }))}
            onChange={(value) => updatePoseSetting('depthModel', value as PoseAnalysisSettings['depthModel'])}
            disabled={busy}
          />
          <SettingSlider
            label="Detection Confidence"
            value={poseSettings.detectionConfidence}
            min={0.1}
            max={0.9}
            step={0.05}
            onChange={(value) => updatePoseSetting('detectionConfidence', value)}
            format={(value) => value.toFixed(2)}
            disabled={busy}
          />
          <SettingSlider
            label="Tracking Confidence"
            value={poseSettings.trackingConfidence}
            min={0.1}
            max={0.9}
            step={0.05}
            onChange={(value) => updatePoseSetting('trackingConfidence', value)}
            format={(value) => value.toFixed(2)}
            disabled={busy}
          />
          <SettingSlider
            label="Motion Smoothing"
            value={poseSettings.smoothing}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(value) => updatePoseSetting('smoothing', value)}
            format={(value) => `${Math.round(value * 100)}%`}
            disabled={busy}
          />
          <StepperRow label="Temporal Window" value={poseSettings.temporalWindow} suffix="frames" onMinus={() => stepPoseSetting('temporalWindow', -1)} onPlus={() => stepPoseSetting('temporalWindow', 1)} disabled={busy} />
          <StepperRow label="Max People" value={poseSettings.maxPeople} onMinus={() => stepPoseSetting('maxPeople', -1)} onPlus={() => stepPoseSetting('maxPeople', 1)} disabled={busy} />
          <label className="toggle-row">
            <input type="checkbox" checked={poseSettings.fillGaps} onChange={(event) => updatePoseSetting('fillGaps', event.target.checked)} disabled={busy} />
            Fill gaps
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={useCameraMove} onChange={(event) => setUseCameraMove(event.target.checked)} disabled={busy} />
            Camera move solve
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={poseSettings.optimizeForExport} onChange={(event) => updatePoseSetting('optimizeForExport', event.target.checked)} disabled={busy} />
            Optimize for export
          </label>
          <SettingSlider label="Sample FPS" value={sampleFps} min={4} max={24} step={1} onChange={setSampleFps} format={(value) => `${value} fps`} disabled={busy} />
          <SettingSelect
            label="Export Resolution"
            value={resolution}
            options={[
              { value: 'auto', label: 'Auto (long-edge)', title: 'Keeps the source long-edge scaling.' },
              { value: '720p', label: '720p (Seedance)', title: 'Scales control layers so the short edge is 720.' }
            ]}
            onChange={(value) => setResolution(value as ExportResolution)}
            disabled={busy}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <Layers3 size={16} />
            <span>Control Layers</span>
          </div>
          <div className="chip-grid">
            {CONTROL_LAYERS.map((layer) => (
              <label key={layer.key} className={selectedLayers.includes(layer.key) ? 'chip-toggle selected' : 'chip-toggle'}>
                <input type="checkbox" checked={selectedLayers.includes(layer.key)} onChange={() => toggleLayer(layer.key)} disabled={busy} />
                {layer.label}
              </label>
            ))}
          </div>
          <div className="setting-row">
            <span>Generated</span>
            <strong>{analysis ? `${selectedLayers.length} layers` : '--'}</strong>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Box size={16} />
            <span>Pose Diagnostics</span>
          </div>
          <div className="metric-grid">
            <Metric label="Frames" value={poseData ? String(poseData.summary.totalFrames || poseData.frames.length) : '--'} />
            <Metric label="Tracked" value={poseData ? `${poseData.summary.rawDetectedFrames ?? poseData.summary.detectedFrames}/${poseData.summary.totalFrames || poseData.frames.length}` : '--'} />
            <Metric label="Confidence" value={poseData ? `${Math.round(poseData.summary.averageScore * 100)}%` : '--'} />
            <Metric label="Filled" value={poseData ? String(poseData.summary.filledFrames || 0) : '--'} />
            <Metric label="People" value={poseData ? String(poseData.summary.maxPeopleDetected || 0) : '--'} />
            <Metric label="Motion" value={poseData ? poseData.summary.motionEnergy.toFixed(3) : '--'} />
          </div>
          <div className="diagnostic-list">
            {(poseData?.summary.diagnostics || ['Run analysis to see tracking diagnostics.']).slice(0, 3).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Camera size={16} />
            <span>Camera Move</span>
          </div>
          <div className="metric-grid">
            <Metric label="Pan" value={cameraMotionData ? `${cameraMotionData.summary.panPixels.toFixed(0)}px` : '--'} />
            <Metric label="Tilt" value={cameraMotionData ? `${cameraMotionData.summary.tiltPixels.toFixed(0)}px` : '--'} />
            <Metric label="Zoom" value={cameraMotionData ? `${cameraMotionData.summary.zoomRatio.toFixed(2)}x` : '--'} />
            <Metric label="Solve" value={cameraMotionData ? `${Math.round(cameraMotionData.summary.averageConfidence * 100)}%` : '--'} />
          </div>
        </section>

        <section className="panel quality-panel">
          <div className="panel-title">
            <Gauge size={16} />
            <span>Quality Score</span>
          </div>
          <div className="quality-layout">
            <div className="quality-ring" style={{ background: `conic-gradient(var(--green) ${qualityReport.score * 3.6}deg, #1a2224 0deg)` }}>
              <strong>{qualityReport.score}</strong>
            </div>
            <div className="quality-list">
              <InfoRow label="Tracking" value={qualityReport.tracking} />
              <InfoRow label="Stability" value={qualityReport.camera} />
              <InfoRow label="Completeness" value={qualityReport.layers} />
              <InfoRow label="Overall" value={qualityStatus} />
            </div>
          </div>
        </section>

        <section className="panel exports-panel">
          <div className="panel-title">
            <Download size={16} />
            <span>Export Presets</span>
          </div>
          <div className="preset-grid">
            {EXPORT_PRESETS.map((preset) => (
              <PresetTile key={preset.key} preset={preset.key} label={preset.label} selected={exportPresets.includes(preset.key)} onToggle={() => togglePreset(preset.key)} disabled={busy} />
            ))}
          </div>
          <button className="primary-action export-button" onClick={exportBundle} disabled={!poseData || !analysis || busy}>
            <FileArchive size={17} />
            Export Production Pack
          </button>
          {exportResult ? (
            <div className="export-result">
              <strong>Bundle ready</strong>
              <div className="export-result-actions">
                <button className="secondary-action" onClick={() => window.motionPrevis?.openPath(exportResult.outputDir)}>
                  <FolderOpen size={15} />
                  Open Folder
                </button>
                <button className="secondary-action" onClick={() => window.motionPrevis?.revealPath(exportResult.zipPath)}>
                  Reveal ZIP
                </button>
              </div>
              <div className="blockout-send">
                <span className="blockout-send-label">
                  <Send size={13} /> Send to Blockout
                  <em className={blockoutAvailable ? 'blockout-dot on' : 'blockout-dot'} title={blockoutAvailable ? 'Blockout is running' : 'Blockout not detected'} />
                </span>
                <div className="export-result-actions">
                  <button className="secondary-action" onClick={() => sendToBlockout('reference')} disabled={!blockoutAvailable}>
                    Reference
                  </button>
                  <button className="secondary-action" onClick={() => sendToBlockout('depth')} disabled={!blockoutAvailable}>
                    Depth
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-note">Exports include control videos, OpenPose skeleton + keypoints, prompts, shot bible, quality report, Blender scripts, and ZIP.</div>
          )}
        </section>

        <section className="panel system-panel">
          <div className="panel-title">
            <Info size={16} />
            <span>System</span>
          </div>
          <strong>{CREDIT_LINE}</strong>
          <span className="system-links">
            <ExternalLinkButton url="https://wassermanproductions.com">WassermanProductions.com</ExternalLinkButton>
            <ExternalLinkButton url="https://wasserman.ai">Wasserman.ai</ExternalLinkButton>
          </span>
          <span>Electron {versions.electron || '--'}</span>
          <span>Outputs: {versions.workspace || '--'}</span>
        </section>
      </aside>
      </div>

      {restorePrompt ? (
        <div className="restore-banner" role="dialog" aria-label="Restore last project">
          <RotateCcw size={16} />
          <span>Restore your last project — {restorePrompt.sourceName || 'previous clip'}?</span>
          <div>
            <button className="secondary-action" onClick={restoreLastSession}>Restore</button>
            <button className="secondary-action ghost" onClick={() => setRestorePrompt(null)}>Dismiss</button>
          </div>
        </div>
      ) : null}

      {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={toast.tone === 'error' ? 'toast error' : 'toast'}>
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    const error = new Error('Analysis cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function WelcomeState({ onImport, onHelp }: { onImport: () => void; onHelp: () => void }) {
  return (
    <div className="welcome-state">
      <img src={logoUrl} alt="Motion Previs Studio" className="welcome-logo" />
      <h2>Motion Previs Studio v4</h2>
      <p>Turn a reference shot into pose, depth, and camera control layers for AI-film previs and Blockout.</p>
      <div className="welcome-actions">
        <button className="primary-action" onClick={onImport}>
          <Upload size={17} />
          Import a clip
        </button>
        <button className="secondary-action" onClick={onHelp}>
          <HelpCircle size={16} />
          Quick start
        </button>
      </div>
      <p className="welcome-credit">{CREDIT_LINE}</p>
    </div>
  );
}

const HELP_CARDS: { step: string; title: string; body: string }[] = [
  { step: '1', title: 'Import', body: 'Open a local clip or paste a YouTube / direct video URL.' },
  { step: '2', title: 'Trim', body: 'Drag the Start/End sliders to the exact shot range you want.' },
  { step: '3', title: 'Mode', body: 'Pick a Reference Mode: camera only, actor, object, or full scene.' },
  { step: '4', title: 'Analyze', body: 'Run Analysis to solve pose and the subject-masked camera move. Cancel any time.' },
  { step: '5', title: 'Preview', body: 'Scrub the reference, pose overlay, camera path, depth, and 3D skeleton.' },
  { step: '6', title: 'Export', body: 'Export the Production Pack, then Send to Blockout as a ghost reference.' }
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="help-overlay" role="dialog" aria-label="Quick start" onClick={onClose}>
      <div className="help-panel" onClick={(event) => event.stopPropagation()}>
        <div className="help-header">
          <div className="help-title">
            <img src={logoUrl} alt="" className="brand-logo-sm" />
            <h2>Quick Start</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close help" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="help-cards">
          {HELP_CARDS.map((card) => (
            <div key={card.step} className="help-card">
              <span className="help-step">{card.step}</span>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
        <p className="help-credit">{CREDIT_LINE}</p>
      </div>
    </div>
  );
}

function StageRail({ steps, activeStage, stage }: { steps: { key: StageKey; label: string }[]; activeStage: StageKey | null; stage: Stage }) {
  const doneMap: Record<StageKey, boolean> = {
    prepare: stage === 'ready' || stage === 'exported' || stage === 'exporting' || (activeStage !== null && activeStage !== 'prepare'),
    pose: stage === 'ready' || stage === 'exported' || stage === 'exporting' || activeStage === 'camera' || activeStage === 'encode' || activeStage === 'bundle',
    camera: stage === 'exported' || stage === 'exporting' || activeStage === 'encode' || activeStage === 'bundle',
    encode: stage === 'exported' || activeStage === 'bundle',
    bundle: stage === 'exported'
  };
  return (
    <div className="stage-rail" aria-label="Analysis stages">
      {steps.map((step) => {
        const active = activeStage === step.key;
        const done = doneMap[step.key];
        return (
          <div key={step.key} className={`stage-chip${active ? ' active' : ''}${done ? ' done' : ''}`}>
            <span className="stage-dot" />
            {step.label}
          </div>
        );
      })}
    </div>
  );
}

function WorkflowStepper({ activeStep }: { activeStep: number }) {
  return (
    <nav className="workflow-stepper" aria-label="Workflow">
      {WORKFLOW_STEPS.map((step, index) => (
        <div key={step} className={index <= activeStep ? 'workflow-step active' : 'workflow-step'}>
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </div>
      ))}
    </nav>
  );
}

function IconButton({ label, children, disabled, onClick }: { label: string; children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className="icon-button" type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function ShotThumb({ previewUrl, poster }: { previewUrl?: string; poster?: string }) {
  if (poster) {
    return (
      <span className="shot-thumb">
        <img src={poster} alt="" />
      </span>
    );
  }
  if (previewUrl) {
    return (
      <span className="shot-thumb">
        <video src={previewUrl} muted playsInline preload="metadata" />
      </span>
    );
  }
  return (
    <span className="shot-thumb empty">
      <FilmIcon />
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PreviewPane({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return (
    <article className={`preview-pane ${tone}`}>
      <header>{title}</header>
      <div className="preview-content">{children}</div>
    </article>
  );
}

function EmptyPreview({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <div className="empty-preview">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function LayerVideo({ url, poster, label }: { url?: string; poster?: string; label: string }) {
  return url ? <video src={url} poster={poster} muted loop controls playsInline /> : <EmptyPreview label={label} />;
}

function CameraPathPreview({ videoUrl, poster, cameraMotionData }: { videoUrl: string; poster?: string; cameraMotionData: CameraMotionData | null }) {
  const points = mapCameraPath(cameraMotionData);
  return (
    <div className="camera-path-preview">
      {videoUrl ? <video src={videoUrl} poster={poster} muted loop playsInline /> : <EmptyPreview label="Camera path appears after analysis" />}
      <div className="path-grid" />
      <svg className="camera-path-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points.map((point) => point.join(',')).join(' ')} />
        {points.map(([x, y], index) => (
          <circle key={`${x}-${y}-${index}`} cx={x} cy={y} r={index === points.length - 1 ? 2.8 : 1.8} />
        ))}
      </svg>
      <div className="camera-gizmo">
        <Camera size={30} />
      </div>
    </div>
  );
}

function PoseOverlayPreview({ frame, videoUrl, poster, width, height }: { frame?: PoseFrame; videoUrl: string; poster?: string; width: number; height: number }) {
  const poses = frame?.poses?.length
    ? frame.poses
    : frame?.landmarks?.length
      ? [{ id: 0, landmarks: frame.landmarks, worldLandmarks: frame.worldLandmarks, score: frame.score }]
      : [];
  if (!videoUrl && !frame) return <EmptyPreview label="Actor pose appears after tracking" />;
  return (
    <div className="pose-overlay-preview">
      {videoUrl ? <video src={videoUrl} poster={poster} muted loop playsInline /> : null}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {poses.map((pose, poseIndex) => (
          <g key={pose.id} style={{ opacity: poseIndex === 0 ? 1 : 0.62 }}>
            {POSE_CONNECTIONS.map(([from, to], index) => {
              const a = pose.landmarks[from];
              const b = pose.landmarks[to];
              if (!a || !b) return null;
              const confident = Math.min(a.visibility ?? 1, b.visibility ?? 1) > 0.45;
              return (
                <line
                  key={`${pose.id}-${from}-${to}-${index}`}
                  x1={a.x * width}
                  y1={a.y * height}
                  x2={b.x * width}
                  y2={b.y * height}
                  stroke={poseConnectionColor(from, to)}
                  className={confident ? 'confident' : ''}
                />
              );
            })}
            {pose.landmarks.map((point, index) => (
              <circle key={`${pose.id}-${index}`} cx={point.x * width} cy={point.y * height} r={index <= 10 ? 5 : 7} className={index === 0 ? 'head-joint' : ''} />
            ))}
          </g>
        ))}
      </svg>
      <span className={frame?.source === 'filled' ? 'overlay-note filled' : 'overlay-note'}>
        {poses.length ? `${poses.length} pose${poses.length === 1 ? '' : 's'} ${frame?.source === 'filled' ? 'filled' : 'tracked'}` : 'Waiting for pose track'}
      </span>
    </div>
  );
}

function PoseAllPreview({ frame, poseData }: { frame?: PoseFrame; poseData: PoseData | null }) {
  const summary = poseData?.summary;
  return (
    <div className="pose-all-preview">
      <ThreePreview frame={frame} />
      <div className="stick-figure-hud">
        <span>{frame?.source === 'filled' ? 'Filled frame' : frame?.landmarks?.length ? 'Tracked frame' : 'No pose'}</span>
        <strong>{summary ? `${summary.detectedFrames}/${summary.totalFrames || poseData?.frames.length || 0}` : '--'}</strong>
      </div>
    </div>
  );
}

function TransportBar({
  sampleFps,
  isPlaying,
  onPlayPause,
  onStepBack,
  onStepForward,
  onSkipStart,
  onSkipEnd,
  disabled
}: {
  sampleFps: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSkipStart: () => void;
  onSkipEnd: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="transport-bar" aria-label="Transport controls">
      <IconButton label="Skip to start" onClick={onSkipStart} disabled={disabled}>
        <SkipBack size={16} />
      </IconButton>
      <IconButton label="Step back" onClick={onStepBack} disabled={disabled}>
        <SkipBack size={14} />
      </IconButton>
      <IconButton label={isPlaying ? 'Pause' : 'Play'} onClick={onPlayPause} disabled={disabled}>
        {isPlaying ? <Pause size={17} /> : <Play size={17} />}
      </IconButton>
      <IconButton label="Step forward" onClick={onStepForward} disabled={disabled}>
        <SkipForward size={14} />
      </IconButton>
      <IconButton label="Skip to end" onClick={onSkipEnd} disabled={disabled}>
        <SkipForward size={16} />
      </IconButton>
      <span className="fps-chip">{sampleFps} fps</span>
      <div className="transport-spacer" />
    </div>
  );
}

function TimelineFilmstrip({ previewUrl, poster }: { previewUrl?: string; poster?: string }) {
  return (
    <div className="timeline-filmstrip" aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <ShotThumb key={index} previewUrl={previewUrl} poster={poster} />
      ))}
    </div>
  );
}

function StatusItem({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="status-item">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingSelect({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string;
  value: string;
  options: { value: string; label: string; title?: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="select-row setting-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map((option) => (
          <option key={option.value} value={option.value} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className="slider-row setting-control">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} disabled={disabled} />
      <strong>{format(value)}</strong>
    </label>
  );
}

function StepperRow({
  label,
  value,
  suffix,
  onMinus,
  onPlus,
  disabled
}: {
  label: string;
  value: number;
  suffix?: string;
  onMinus: () => void;
  onPlus: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="stepper-row setting-control">
      <span>{label}</span>
      <div>
        <strong>
          {value}
          {suffix ? ` ${suffix}` : ''}
        </strong>
        <button type="button" onClick={onMinus} disabled={disabled} aria-label={`Decrease ${label}`}>
          -
        </button>
        <button type="button" onClick={onPlus} disabled={disabled} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function PresetTile({
  preset,
  label,
  selected,
  disabled,
  onToggle
}: {
  preset: ExportPreset;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const accent = PRESET_ACCENTS[preset];
  return (
    <button className={selected ? 'preset-card selected' : 'preset-card'} type="button" onClick={onToggle} disabled={disabled} aria-pressed={selected}>
      <span className="preset-logo" style={{ color: accent }}>
        {label.slice(0, 1)}
      </span>
      <strong>{label}</strong>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ExternalLinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="external-link"
      onClick={() => {
        if (window.motionPrevis?.openExternal) {
          void window.motionPrevis.openExternal(url);
          return;
        }
        window.open(url, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
    </button>
  );
}

function BrainGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M6.4 3.1c-1.7.1-3 1.4-3 3 0 .4.1.7.2 1A3.4 3.4 0 0 0 5 13.7c.6.7 1.5 1.1 2.5 1.1h3c1 0 1.9-.4 2.5-1.1a3.4 3.4 0 0 0 1.4-6.6c.1-.3.2-.6.2-1 0-1.6-1.3-2.9-3-3-.7-1-1.8-1.5-3.1-1.5S7.1 2.1 6.4 3.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.9 3.2v11.5M6.1 6.3h2.8M8.9 9H6M8.9 11.9H6.7M11.8 6.3H9M12 9H9M11.3 11.9H9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
      <rect x="2" y="2" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2v14M16 2v14M2 6h4M16 6h4M2 12h4M16 12h4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function selectPoseFrame(poseData: PoseData | null, time: number): PoseFrame | undefined {
  if (!poseData?.frames.length) return undefined;
  const index = clamp(Math.round(time * poseData.fps), 0, poseData.frames.length - 1);
  return poseData.frames[index];
}

function workflowStepForStage(stage: Stage) {
  if (stage === 'exporting' || stage === 'exported') return 3;
  if (stage === 'ready') return 2;
  if (stage === 'preparing' || stage === 'tracking') return 1;
  return 0;
}

function mapCameraPath(cameraMotionData: CameraMotionData | null): [number, number][] {
  const frames = cameraMotionData?.frames || [];
  if (!frames.length) {
    return [
      [14, 70],
      [28, 60],
      [42, 54],
      [55, 58],
      [68, 66],
      [83, 77]
    ];
  }
  const sampled = frames.filter((_, index) => index % Math.max(1, Math.floor(frames.length / 7)) === 0).slice(0, 8);
  const maxPan = Math.max(1, ...sampled.map((frame) => Math.abs(frame.cameraMove.pan)));
  const maxTilt = Math.max(1, ...sampled.map((frame) => Math.abs(frame.cameraMove.tilt)));
  return sampled.map((frame, index) => {
    const x = 14 + (index / Math.max(sampled.length - 1, 1)) * 72 + (frame.cameraMove.pan / maxPan) * 5;
    const y = 68 + (frame.cameraMove.tilt / maxTilt) * 18;
    return [clamp(x, 8, 92), clamp(y, 24, 88)];
  });
}

function formatDisplayDate(value?: string) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isBusy(stage: Stage) {
  return stage === 'importing' || stage === 'preparing' || stage === 'tracking' || stage === 'exporting';
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
}

function toShotTitle(name: string) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Shot 01A';
  return base
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .slice(0, 48);
}
