import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Box,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Cpu,
  Download,
  FastForward,
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
  MoreVertical,
  Pause,
  Play,
  Plus,
  Redo2,
  Rewind,
  Scissors,
  Search,
  Save,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SquareStack,
  Star,
  Undo2,
  Upload,
  Volume2,
  Youtube
} from 'lucide-react';
import type {
  AnalysisManifest,
  CameraMotionData,
  ControlLayerKey,
  ExportPreset,
  ExportResult,
  MediaInfo,
  PlanningData,
  PoseData,
  PoseFrame,
  QualityReport,
  SubjectMode
} from './types';
import { createAiDepthVideoBlob } from './lib/aiDepth';
import { analyzeCameraMotionVideo } from './lib/cameraMotion';
import { POSE_CONNECTIONS, analyzePoseVideo } from './lib/pose';
import { createPoseVideoBlob } from './lib/poseVideo';
import { PoseCanvas } from './components/PoseCanvas';
import { ThreePreview } from './components/ThreePreview';

type Stage = 'idle' | 'importing' | 'preparing' | 'tracking' | 'ready' | 'exporting' | 'exported' | 'error';

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

const DEMO_SHOTS = [
  { id: '01A', title: 'Tracking In', duration: 24, lens: '35mm' },
  { id: '01B', title: 'Pan Right', duration: 18, lens: '24mm' },
  { id: '01C', title: 'Push In', duration: 12, lens: '50mm' },
  { id: '01D', title: 'Low Angle', duration: 16, lens: '35mm' },
  { id: '01E', title: 'Over Shoulder', duration: 22, lens: '28mm' }
];

const PRESET_ACCENTS: Record<ExportPreset, string> = {
  seedance: '#3ee3d2',
  comfyui: '#9e7cff',
  blender: '#ff932e',
  runway: '#47e571',
  kling: '#45c8ff'
};

export function App() {
  const [source, setSource] = useState<MediaInfo | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisManifest | null>(null);
  const [poseData, setPoseData] = useState<PoseData | null>(null);
  const [cameraMotionData, setCameraMotionData] = useState<CameraMotionData | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState('');
  const [range, setRange] = useState({ start: 0, end: 8 });
  const [sampleFps, setSampleFps] = useState(12);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('Import a clip or paste a web video URL to begin.');
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [useAiDepth, setUseAiDepth] = useState(true);
  const [useCameraMove, setUseCameraMove] = useState(true);
  const [projectTitle, setProjectTitle] = useState('Motion Previs Project');
  const [sceneTitle, setSceneTitle] = useState('Scene 01');
  const [shotTitle, setShotTitle] = useState('Shot 01A');
  const [creativeIntent, setCreativeIntent] = useState('Preserve the reference camera move and timing while allowing new subject design.');
  const [visualStyle, setVisualStyle] = useState('Cinematic AI-film previs with clean blocking, controlled depth, and professional continuity.');
  const [subjectMode, setSubjectMode] = useState<SubjectMode>('camera-only');
  const [selectedLayers, setSelectedLayers] = useState<ControlLayerKey[]>(['depth', 'ai-depth', 'pose', 'camera', 'edges', 'masks']);
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>(['seedance', 'comfyui', 'blender']);
  const referenceVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    window.motionPrevis?.getVersions().then(setVersions).catch(() => undefined);
  }, []);

  const duration = source?.duration || 0;
  const selectedDuration = Math.max(0.1, range.end - range.start);
  const currentPoseFrame = useMemo(() => selectPoseFrame(poseData, currentTime), [currentTime, poseData]);
  const qualityReport = useMemo(
    () => createQualityReport(poseData, cameraMotionData, analysis, selectedLayers, useCameraMove),
    [analysis, cameraMotionData, poseData, selectedLayers, useCameraMove]
  );
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
      qualityReport
    }),
    [
      creativeIntent,
      exportPresets,
      projectTitle,
      qualityReport,
      sceneTitle,
      selectedDuration,
      selectedLayers,
      shotTitle,
      subjectMode,
      useCameraMove,
      visualStyle
    ]
  );

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
    const end = Math.min(media.duration || 8, 8);
    setRange({ start: 0, end: Math.max(0.1, end) });
    setShotTitle(toShotTitle(media.name));
    setStage('idle');
    setMessage('Choose the shot range and run analysis.');
  }

  async function runAnalysis() {
    if (!source) return;
    try {
      setError('');
      setExportResult(null);
      setStage('preparing');
      setProgress(0.05);
      setMessage('Preparing trimmed reference and depth map');
      if (!window.motionPrevis) throw new Error('Desktop bridge is not available in browser preview.');
      const prepared = await window.motionPrevis.prepareAnalysis({
        sourcePath: source.filePath,
        start: range.start,
        end: range.end,
        sampleFps
      });
      setAnalysis(prepared);
      setStage('tracking');
      const pose = await analyzePoseVideo(prepared.referenceUrl, sampleFps, (nextProgress, nextMessage) => {
        setProgress(nextProgress);
        setMessage(nextMessage);
      });
      setPoseData(pose);
      if (useCameraMove) {
        const cameraMove = await analyzeCameraMotionVideo(prepared.referenceUrl, Math.min(sampleFps, 12), (nextProgress, nextMessage) => {
          setProgress(nextProgress);
          setMessage(nextMessage);
        });
        setCameraMotionData(cameraMove);
      } else {
        setCameraMotionData(null);
      }
      setCurrentTime(0);
      setStage('ready');
      setProgress(0.82);
      setMessage('Analysis complete. Review the previews or export the bundle.');
    } catch (err) {
      fail(err);
    }
  }

  async function exportBundle() {
    if (!analysis || !poseData) return;
    try {
      setStage('exporting');
      setProgress(0.82);
      setMessage('Rendering high-contrast pose video');
      const poseVideo = await createPoseVideoBlob(
        poseData,
        analysis.frameSize.width || 1280,
        analysis.frameSize.height || 720,
        (nextProgress, nextMessage) => {
          setProgress(nextProgress);
          setMessage(nextMessage);
        }
      );
      setMessage('Saving Seedance, ComfyUI, and Blender exports');
      const buffer = await poseVideo.arrayBuffer();
      let aiDepthVideoBuffer: ArrayBuffer | undefined;
      if (useAiDepth) {
        try {
          setMessage('Rendering AI Depth Anything pass');
          const aiDepthVideo = await createAiDepthVideoBlob(
            analysis.referenceUrl,
            Math.min(sampleFps, 8),
            analysis.frameSize.width || 1280,
            analysis.frameSize.height || 720,
            (nextProgress, nextMessage) => {
              setProgress(nextProgress);
              setMessage(nextMessage);
            }
          );
          aiDepthVideoBuffer = await aiDepthVideo.arrayBuffer();
        } catch (depthError) {
          console.warn(depthError);
          setMessage('AI depth unavailable; exporting fast depth proxy.');
        }
      }
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
        aiDepthVideoBuffer
      });
      setExportResult(saved);
      setProgress(1);
      setStage('exported');
      setMessage('Export bundle is ready.');
    } catch (err) {
      fail(err);
    }
  }

  function fail(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    setError(text);
    setMessage(text);
    setStage('error');
    setProgress(0);
  }

  function updateStart(value: number) {
    const next = clamp(value, 0, Math.max(0, range.end - 0.1));
    setRange((current) => ({ ...current, start: next }));
  }

  function updateEnd(value: number) {
    const next = clamp(value, range.start + 0.1, Math.max(range.start + 0.1, duration));
    setRange((current) => ({ ...current, end: next }));
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

  const activeWorkflowStep = workflowStepForStage(stage);
  const previewUrl = analysis?.referenceUrl || source?.url || '';
  const previewPoster = analysis?.previewUrl;
  const sourceName = analysis?.sourceName || source?.name || 'No source loaded';
  const durationLabel = source ? formatTime(source.duration) : '--';
  const selectedDurationLabel = `${Math.round(selectedDuration)}s`;
  const frameRateLabel = source?.frameRate
    ? `${source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps`
    : `${sampleFps} fps`;
  const resolutionLabel = source ? `${source.width} x ${source.height}` : '--';
  const qualityStatus = stage === 'exported' ? 'Ready to share' : stage === 'ready' ? 'Ready to export' : qualityReport.readiness;

  return (
    <main className="app-shell">
      <header className="top-chrome">
        <div className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="top-title">
          <h1>Motion Previs Studio v3</h1>
          <p>Created by Sam Wasserman</p>
          <div className="brand-links" aria-label="Wasserman links">
            <ExternalLinkButton url="https://wassermanproductions.com">WassermanProductions.com</ExternalLinkButton>
            <ExternalLinkButton url="https://wasserman.ai">Wasserman.ai</ExternalLinkButton>
          </div>
        </div>
        <WorkflowStepper activeStep={activeWorkflowStep} />
        <div className="top-actions" aria-label="Application tools">
          <IconButton label="Open source" onClick={loadFile} disabled={isBusy(stage)}>
            <FolderOpen size={18} />
          </IconButton>
          <IconButton label="Save project" disabled>
            <Save size={18} />
          </IconButton>
          <IconButton label="Undo" disabled>
            <Undo2 size={18} />
          </IconButton>
          <IconButton label="Redo" disabled>
            <Redo2 size={18} />
          </IconButton>
          <IconButton label="Settings">
            <Settings2 size={18} />
          </IconButton>
          <IconButton label="Help">
            <HelpCircle size={18} />
          </IconButton>
        </div>
      </header>

      <div className="studio-shell">
      <aside className="sidebar left-sidebar">
        <section className="panel shot-bible-panel shot-plan-panel">
          <div className="panel-heading">
            <h2>Shot Bible</h2>
            <button className="round-tool" type="button" title="Add shot">
              <Plus size={17} />
            </button>
          </div>
          <div className="search-row">
            <Search size={15} />
            <input placeholder="Search shots..." aria-label="Search shots" />
          </div>

          <div className="scene-group open">
            <button className="scene-row" type="button">
              <ChevronDown size={15} />
              <Clapperboard size={16} />
              <span>{sceneTitle || 'Scene 01'} - Arrival</span>
            </button>
            <div className="shot-list">
              {DEMO_SHOTS.map((shot, index) => (
                <ShotRow
                  key={shot.id}
                  active={index === 0}
                  shot={`Shot ${shot.id}`}
                  title={index === 0 ? shotTitle || shot.title : shot.title}
                  detail={`${index === 0 ? selectedDurationLabel : `${shot.duration}s`} - ${shot.lens}`}
                  previewUrl={previewUrl}
                  poster={previewPoster}
                />
              ))}
            </div>
          </div>

          {['Scene 02 - Chase', 'Scene 03 - Hideout', 'Scene 04 - Reveal'].map((scene) => (
            <button key={scene} className="scene-row collapsed" type="button">
              <ChevronRight size={15} />
              <FolderOpen size={16} />
              <span>{scene}</span>
            </button>
          ))}
        </section>

        <section className="panel source-panel">
          <div className="panel-title">
            <FileVideo size={16} />
            <span>Source</span>
          </div>
          <div className="import-grid">
            <button className="secondary-action" onClick={loadFile} disabled={isBusy(stage)}>
              <Upload size={16} />
              Import
            </button>
            <button className="secondary-action" onClick={loadUrl} disabled={!url.trim() || isBusy(stage)}>
              <Youtube size={16} />
              YouTube
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
                  {source.width}x{source.height} · {frameRateLabel} · {source.videoCodec}
                </span>
              </div>
              <CheckCircle2 size={16} />
            </div>
          ) : (
            <div className="empty-note">MP4, MOV, MKV, WebM, direct URLs, and YouTube-compatible links.</div>
          )}
        </section>

        <section className="panel project-panel">
          <div className="panel-heading slim">
            <h2>Project Info</h2>
            <ChevronDown size={16} />
          </div>
          <InfoRow label="Project" value={projectTitle} />
          <InfoRow label="Resolution" value={resolutionLabel} />
          <InfoRow label="Frame Rate" value={frameRateLabel} />
          <InfoRow label="Duration" value={durationLabel} />
          <InfoRow label="Date" value={formatDisplayDate(analysis?.createdAt)} />
        </section>

        <section className="panel shot-form-panel">
          <div className="panel-title">
            <SquareStack size={16} />
            <span>Shot Plan</span>
          </div>
          <label className="control-label">
            Project
            <input
              className="text-field"
              value={projectTitle}
              onChange={(event) => setProjectTitle(event.target.value)}
              disabled={isBusy(stage)}
            />
          </label>
          <div className="split-fields">
            <label className="control-label">
              Scene
              <input
                className="text-field"
                value={sceneTitle}
                onChange={(event) => setSceneTitle(event.target.value)}
                disabled={isBusy(stage)}
              />
            </label>
            <label className="control-label">
              Shot
              <input
                className="text-field"
                value={shotTitle}
                onChange={(event) => setShotTitle(event.target.value)}
                disabled={isBusy(stage)}
              />
            </label>
          </div>
          <label className="control-label">
            Intent
            <textarea
              className="textarea-field"
              value={creativeIntent}
              onChange={(event) => setCreativeIntent(event.target.value)}
              disabled={isBusy(stage)}
              rows={2}
            />
          </label>
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
              disabled={!source || isBusy(stage)}
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
              disabled={!source || isBusy(stage)}
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
          <button className="primary-action" onClick={runAnalysis} disabled={!source || isBusy(stage)}>
            <Play size={17} />
            Run Analysis
          </button>
          <div className="progress-track">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className={error ? 'status-text error' : 'status-text'}>{message}</p>
        </section>
      </aside>

      <section className="workspace">
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
            <IconButton label="Inspector">
              <PanelGlyph />
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
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ) : source ? (
              <video src={source.url} controls />
            ) : (
              <EmptyPreview icon={<FileVideo size={30} />} label="Import source video" />
            )}
          </PreviewPane>

          <PreviewPane title="Camera Path" tone="camera-main">
            <CameraPathPreview videoUrl={previewUrl} poster={previewPoster} cameraMotionData={cameraMotionData} />
          </PreviewPane>

          <PreviewPane title="Pose (Actor)" tone="pose-actor">
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

          <PreviewPane title="Pose (All)" tone="pose-all">
            <PoseAllPreview frame={currentPoseFrame} />
          </PreviewPane>
        </div>

        <TransportBar sampleFps={sampleFps} />

        <div className="timeline">
          <div className="timeline-head">
            <span>Shot 01A</span>
            <strong>{selectedDurationLabel}</strong>
          </div>
          <div className="timeline-ruler" aria-hidden="true">
            {[0, 2, 4, 6, 8, 10, 12].map((second) => (
              <span key={second}>{formatTime(second)}</span>
            ))}
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
                className={frame.landmarks.length ? 'pose-tick detected' : 'pose-tick'}
                style={{ left: `${(index / Math.max(poseData.frames.length - 1, 1)) * 100}%` }}
              />
            ))}
          </div>
          <div className="audio-track" aria-hidden="true">
            {Array.from({ length: 80 }, (_, index) => (
              <span key={index} style={{ height: `${10 + ((index * 17) % 28)}px` }} />
            ))}
          </div>
          <div className="timeline-tools">
            <button className="active" type="button">
              <Scissors size={15} />
              Trim
            </button>
            <button type="button">
              <Camera size={15} />
              Move
            </button>
            <button type="button">
              <ImageIcon size={15} />
              Markers
            </button>
            <button type="button">
              <SlidersHorizontal size={15} />
              Filters
            </button>
          </div>
        </div>

        <div className="analysis-dock">
          <StatusItem icon={<CheckCircle2 size={18} />} label="Analysis Status" value={stage === 'ready' || stage === 'exported' ? 'Ready' : stage} />
          <StatusItem icon={<BrainGlyph />} label="Model" value="MediaPipe Pose + Depth" />
          <StatusItem icon={<Cpu size={18} />} label="Device" value="CPU Optimized" />
          <StatusItem icon={<Monitor size={18} />} label="Resolution" value={resolutionLabel} />
          <StatusItem icon={<Clapperboard size={18} />} label="FPS" value={frameRateLabel} />
          <button
            className="run-dock-button"
            aria-label="Run analysis from dock"
            onClick={runAnalysis}
            disabled={!source || isBusy(stage)}
          >
            <Play size={19} />
            Run Analysis
            <ChevronDown size={16} />
          </button>
          <StatusItem label="Estimated Time" value={source ? '00:01:24' : '--'} />
        </div>
      </section>

      <aside className="sidebar right-sidebar">
        <section className="panel camera-panel">
          <div className="panel-heading">
            <h2>Camera Move</h2>
            <span className={useCameraMove ? 'status-pill green' : 'status-pill'}>{useCameraMove ? 'Camera only' : 'Off'}</span>
          </div>
          <ModeSegment
            label="Mode"
            options={[
              { label: 'Camera only', active: subjectMode === 'camera-only', onClick: () => setSubjectMode('camera-only') },
              { label: 'With Subject', active: subjectMode === 'actor-motion', onClick: () => setSubjectMode('actor-motion') },
              { label: 'Full Scene', active: subjectMode === 'full-scene', onClick: () => setSubjectMode('full-scene') }
            ]}
            disabled={isBusy(stage)}
          />
          <SliderReadout label="Smoothing" value={65} suffix="%" />
          <label className="select-row">
            <span>Focal Length</span>
            <select defaultValue="35mm">
              <option>24mm</option>
              <option>35mm</option>
              <option>50mm</option>
              <option>85mm</option>
            </select>
          </label>
          <label className="select-row">
            <span>Stabilization</span>
            <select defaultValue="Medium">
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>
          </label>
        </section>

        <section className="panel subject-panel">
          <div className="panel-heading slim">
            <h2>Subject Motion</h2>
          </div>
          <ModeSegment
            label="Tracking"
            options={[
              { label: 'Actor motion', active: subjectMode === 'actor-motion', onClick: () => setSubjectMode('actor-motion') },
              { label: 'Object motion', active: subjectMode === 'object-motion', onClick: () => setSubjectMode('object-motion') },
              { label: 'Off', active: subjectMode === 'camera-only', onClick: () => setSubjectMode('camera-only') }
            ]}
            disabled={isBusy(stage)}
          />
          <label className="control-label">
            Style
            <textarea
              className="textarea-field compact"
              value={visualStyle}
              onChange={(event) => setVisualStyle(event.target.value)}
              disabled={isBusy(stage)}
              rows={2}
            />
          </label>
          <label className="select-row">
            <span>Tracking Confidence</span>
            <select defaultValue="High">
              <option>High</option>
              <option>Medium</option>
              <option>Review</option>
            </select>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked readOnly />
            Foot Lock
          </label>
          <SliderReadout label="Motion Smoothing" value={60} suffix="%" />
          <label className="toggle-row">
            <input type="checkbox" checked readOnly />
            Ground Constraint
          </label>
        </section>

        <section className="panel analyze-panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <span>Analyze</span>
          </div>
          <div className="setting-row">
            <span>Depth pass</span>
            <strong>{useAiDepth ? 'Depth Anything + proxy' : 'Temporal luma proxy'}</strong>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={useAiDepth} onChange={(event) => setUseAiDepth(event.target.checked)} />
            AI depth export
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={useCameraMove} onChange={(event) => setUseCameraMove(event.target.checked)} />
            Camera move solve
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked readOnly />
            Optimize for export
          </label>
          <label className="control-label">
            Sample FPS
            <input
              type="range"
              min={4}
              max={24}
              step={1}
              value={sampleFps}
              onChange={(event) => setSampleFps(Number(event.target.value))}
              disabled={isBusy(stage)}
            />
          </label>
          <div className="setting-row">
            <span>Current</span>
            <strong>{sampleFps} fps</strong>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Layers3 size={16} />
            <span>Control Layers</span>
          </div>
          <div className="chip-grid">
            {CONTROL_LAYERS.map((layer) => (
              <label key={layer.key} className={selectedLayers.includes(layer.key) ? 'chip-toggle selected' : 'chip-toggle'}>
                <input
                  type="checkbox"
                  checked={selectedLayers.includes(layer.key)}
                  onChange={() => toggleLayer(layer.key)}
                  disabled={isBusy(stage)}
                />
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
            <span>Pose</span>
          </div>
          <div className="metric-grid">
            <Metric label="Frames" value={poseData ? String(poseData.frames.length) : '--'} />
            <Metric label="Detected" value={poseData ? String(poseData.summary.detectedFrames) : '--'} />
            <Metric label="Confidence" value={poseData ? `${Math.round(poseData.summary.averageScore * 100)}%` : '--'} />
            <Metric label="Motion" value={poseData ? poseData.summary.motionEnergy.toFixed(3) : '--'} />
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
            <div
              className="quality-ring"
              style={{ background: `conic-gradient(var(--green) ${qualityReport.score * 3.6}deg, #1a2224 0deg)` }}
            >
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

        <section className="panel prompt-panel">
          <div className="panel-heading slim">
            <h2>Prompt Pack</h2>
          </div>
          <div className="prompt-line">
            <FileArchive size={15} />
            <span>Generate Prompt Pack</span>
            <button className="secondary-action compact-button" onClick={exportBundle} disabled={!poseData || !analysis || stage === 'exporting'}>
              Generate
            </button>
          </div>
        </section>

        <section className="panel exports-panel">
          <div className="panel-title">
            <Download size={16} />
            <span>Export Presets</span>
          </div>
          <div className="preset-grid">
            {EXPORT_PRESETS.map((preset) => (
              <PresetTile
                key={preset.key}
                preset={preset.key}
                label={preset.label}
                selected={exportPresets.includes(preset.key)}
                onToggle={() => togglePreset(preset.key)}
                disabled={isBusy(stage)}
              />
            ))}
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={useCameraMove} onChange={(event) => setUseCameraMove(event.target.checked)} />
            Camera move
          </label>
          <button className="primary-action export-button" onClick={exportBundle} disabled={!poseData || !analysis || stage === 'exporting'}>
            <Download size={17} />
            Export Production Pack
          </button>
          {exportResult ? (
            <div className="export-result">
              <strong>Bundle ready</strong>
              <button className="secondary-action" onClick={() => window.motionPrevis?.openPath(exportResult.outputDir)}>
                <FolderOpen size={15} />
                Open Folder
              </button>
              <button className="secondary-action" onClick={() => window.motionPrevis?.revealPath(exportResult.zipPath)}>
                Reveal ZIP
              </button>
            </div>
          ) : (
            <div className="empty-note">Exports include control videos, prompts, shot bible, quality report, Blender scripts, and ZIP.</div>
          )}
        </section>

        <section className="panel system-panel">
          <div className="panel-title">
            <Info size={16} />
            <span>System</span>
          </div>
          <strong>Developed and created by Sam Wasserman</strong>
          <span className="system-links">
            <ExternalLinkButton url="https://wassermanproductions.com">WassermanProductions.com</ExternalLinkButton>
            <ExternalLinkButton url="https://wasserman.ai">Wasserman.ai</ExternalLinkButton>
          </span>
          <span>Electron {versions.electron || '--'}</span>
          <span>Outputs: {versions.workspace || '--'}</span>
        </section>
      </aside>
      </div>
    </main>
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

function IconButton({
  label,
  children,
  disabled,
  onClick
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className="icon-button" type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function ShotRow({
  active,
  shot,
  title,
  detail,
  previewUrl,
  poster
}: {
  active?: boolean;
  shot: string;
  title: string;
  detail: string;
  previewUrl: string;
  poster?: string;
}) {
  return (
    <button className={active ? 'shot-row active' : 'shot-row'} type="button">
      <ShotThumb previewUrl={previewUrl} poster={poster} />
      <span>
        <strong>{shot}</strong>
        <em>{detail}</em>
        <small>{title}</small>
      </span>
      {active ? <Star size={15} fill="currentColor" /> : <MoreVertical size={15} />}
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

function PreviewPane({
  title,
  tone,
  children
}: {
  title: string;
  tone: string;
  children: ReactNode;
}) {
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

function CameraPathPreview({
  videoUrl,
  poster,
  cameraMotionData
}: {
  videoUrl: string;
  poster?: string;
  cameraMotionData: CameraMotionData | null;
}) {
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

function PoseOverlayPreview({
  frame,
  videoUrl,
  poster,
  width,
  height
}: {
  frame?: PoseFrame;
  videoUrl: string;
  poster?: string;
  width: number;
  height: number;
}) {
  if (!videoUrl && !frame) return <EmptyPreview label="Actor pose appears after tracking" />;
  return (
    <div className="pose-overlay-preview">
      {videoUrl ? <video src={videoUrl} poster={poster} muted loop playsInline /> : null}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {frame?.landmarks?.length
          ? POSE_CONNECTIONS.map(([from, to], index) => {
              const a = frame.landmarks[from];
              const b = frame.landmarks[to];
              if (!a || !b) return null;
              const confident = Math.min(a.visibility ?? 1, b.visibility ?? 1) > 0.45;
              return (
                <line
                  key={`${from}-${to}-${index}`}
                  x1={a.x * width}
                  y1={a.y * height}
                  x2={b.x * width}
                  y2={b.y * height}
                  className={confident ? 'confident' : ''}
                />
              );
            })
          : null}
        {frame?.landmarks?.map((point, index) => (
          <circle key={index} cx={point.x * width} cy={point.y * height} r={index <= 10 ? 5 : 7} />
        ))}
      </svg>
      {!frame?.landmarks?.length ? <span className="overlay-note">Waiting for pose track</span> : null}
    </div>
  );
}

function PoseAllPreview({ frame }: { frame?: PoseFrame }) {
  return (
    <div className="pose-all-preview">
      <ThreePreview frame={frame} />
      <div className="mini-actors" aria-hidden="true">
        {['#39e221', '#ff8a00', '#149dff', '#df3d87'].map((color, index) => (
          <svg key={color} viewBox="0 0 48 92" style={{ color, transform: `translateX(${index * 5}px)` }}>
            <circle cx="24" cy="11" r="7" />
            <path d="M24 19 L24 48 M12 31 L24 25 L36 31 M24 48 L14 78 M24 48 L35 78" />
          </svg>
        ))}
      </div>
    </div>
  );
}

function TransportBar({ sampleFps }: { sampleFps: number }) {
  return (
    <div className="transport-bar" aria-label="Transport controls">
      <IconButton label="Skip back">
        <SkipBack size={16} />
      </IconButton>
      <IconButton label="Rewind">
        <Rewind size={16} />
      </IconButton>
      <IconButton label="Play">
        <Play size={17} />
      </IconButton>
      <IconButton label="Pause">
        <Pause size={17} />
      </IconButton>
      <IconButton label="Fast forward">
        <FastForward size={16} />
      </IconButton>
      <IconButton label="Skip forward">
        <SkipForward size={16} />
      </IconButton>
      <span className="fps-chip">{sampleFps} fps</span>
      <div className="transport-spacer" />
      <IconButton label="Snapshot">
        <Camera size={16} />
      </IconButton>
      <IconButton label="Contact sheet">
        <ImageIcon size={16} />
      </IconButton>
      <IconButton label="Audio">
        <Volume2 size={16} />
      </IconButton>
      <div className="mini-volume" />
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

function ModeSegment({
  label,
  options,
  disabled
}: {
  label: string;
  options: { label: string; active: boolean; onClick: () => void }[];
  disabled?: boolean;
}) {
  return (
    <div className="mode-segment">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button key={option.label} className={option.active ? 'active' : ''} type="button" onClick={option.onClick} disabled={disabled}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SliderReadout({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={0} max={100} value={value} onChange={() => undefined} />
      <strong>
        {value}
        {suffix}
      </strong>
    </label>
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
    <button
      className={selected ? 'preset-card selected' : 'preset-card'}
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={selected}
    >
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

function PanelGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
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

function createQualityReport(
  poseData: PoseData | null,
  cameraMotionData: CameraMotionData | null,
  analysis: AnalysisManifest | null,
  selectedLayers: ControlLayerKey[],
  useCameraMove: boolean
): QualityReport {
  const totalFrames = poseData?.frames.length || 0;
  const detectedFrames = poseData?.summary.detectedFrames || 0;
  const trackingScore = totalFrames ? detectedFrames / totalFrames : 0;
  const cameraScore = useCameraMove ? cameraMotionData?.summary.averageConfidence || 0 : 0;
  const layerScore = analysis ? Math.min(1, selectedLayers.length / 6) : 0;
  const score = Math.round(trackingScore * 34 + cameraScore * 42 + layerScore * 24);
  const readiness: QualityReport['readiness'] = score >= 80 ? 'Ready' : score >= 58 ? 'Review' : 'Blocked';

  return {
    score,
    tracking: qualityBand(trackingScore),
    camera: useCameraMove ? qualityBand(cameraScore) : 'Missing',
    layers: qualityBand(layerScore),
    readiness,
    notes: [
      `Pose frames detected: ${detectedFrames}/${totalFrames}`,
      `Camera confidence: ${Math.round(cameraScore * 100)}%`,
      `Selected control layers: ${selectedLayers.join(', ')}`
    ]
  };
}

function qualityBand(value: number): QualityReport['tracking'] {
  if (value >= 0.82) return 'Excellent';
  if (value >= 0.64) return 'Good';
  if (value > 0) return 'Review';
  return 'Missing';
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
