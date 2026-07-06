import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  Camera,
  Download,
  FileVideo,
  FolderOpen,
  Link,
  Play,
  Scissors,
  Settings2,
  SquareStack,
  Upload
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
import { analyzePoseVideo } from './lib/pose';
import { createPoseVideoBlob } from './lib/poseVideo';
import { PoseCanvas } from './components/PoseCanvas';
import { ThreePreview } from './components/ThreePreview';

type Stage = 'idle' | 'importing' | 'preparing' | 'tracking' | 'ready' | 'exporting' | 'exported' | 'error';

const SUBJECT_MODES: { key: SubjectMode; label: string; detail: string }[] = [
  { key: 'camera-only', label: 'Camera', detail: 'Move only' },
  { key: 'actor-motion', label: 'Actor', detail: 'Body motion' },
  { key: 'object-motion', label: 'Object', detail: 'Path motion' },
  { key: 'full-scene', label: 'Scene', detail: 'Everything' }
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

  return (
    <main className="app-shell">
      <aside className="sidebar left-sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <SquareStack size={19} />
          </div>
          <div>
            <h1>Motion Previs Studio v2</h1>
            <p>Created by Sam Wasserman</p>
            <div className="brand-links" aria-label="Wasserman links">
              <ExternalLinkButton url="https://wassermanproductions.com">WassermanProductions.com</ExternalLinkButton>
              <ExternalLinkButton url="https://wasserman.ai">Wasserman.ai</ExternalLinkButton>
            </div>
          </div>
        </div>

        <section className="panel source-panel">
          <div className="panel-title">
            <FileVideo size={16} />
            <span>Source</span>
          </div>
          <button className="primary-action" onClick={loadFile} disabled={isBusy(stage)}>
            <Upload size={17} />
            Import
          </button>
          <div className="url-row">
            <Link size={15} />
            <input
              value={url}
              placeholder="YouTube or video URL"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && url.trim()) loadUrl();
              }}
            />
          </div>
          <button className="secondary-action" onClick={loadUrl} disabled={!url.trim() || isBusy(stage)}>
            Fetch URL
          </button>
          {source ? (
            <div className="source-meta">
              <strong>{source.name}</strong>
              <span>
                {source.width}x{source.height} · {formatTime(source.duration)} · {source.videoCodec}
              </span>
            </div>
          ) : (
            <div className="empty-note">MP4, MOV, MKV, WebM, direct URLs, and YouTube-compatible links.</div>
          )}
        </section>

        <section className="panel shot-plan-panel">
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
              rows={3}
            />
          </label>
        </section>

        <section className="panel">
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
          <div>
            <span className="toolbar-label">3D Preview</span>
            <strong>{analysis ? analysis.sourceName : 'No shot loaded'}</strong>
          </div>
          <div className="segmented">
            <span>Original</span>
            <span>Depth</span>
            <span>Pose</span>
            <span>Combined</span>
          </div>
        </div>

        <div className="preview-grid">
          <PreviewPane title="Reference" tone="reference">
            {analysis ? (
              <video
                ref={referenceVideoRef}
                src={analysis.referenceUrl}
                controls
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ) : source ? (
              <video src={source.url} controls />
            ) : (
              <EmptyPreview icon={<FileVideo size={28} />} label="Import source video" />
            )}
          </PreviewPane>

          <PreviewPane title="Depth" tone="depth">
            {analysis ? <video src={analysis.depthUrl} controls loop muted /> : <EmptyPreview label="Depth map appears after analysis" />}
          </PreviewPane>

          <PreviewPane title="Pose" tone="pose">
            {poseData ? (
              <PoseCanvas
                frame={currentPoseFrame}
                width={analysis?.frameSize.width || 1280}
                height={analysis?.frameSize.height || 720}
              />
            ) : (
              <EmptyPreview label="High-contrast skeleton appears after tracking" />
            )}
          </PreviewPane>

          <PreviewPane title="3D Stick Figure" tone="three">
            <ThreePreview frame={currentPoseFrame} />
          </PreviewPane>
        </div>

        <div className="timeline">
          <div className="timeline-head">
            <span>Timeline</span>
            <strong>{formatTime(currentTime)}</strong>
          </div>
          <div className="timeline-track">
            <div
              className="timeline-selection"
              style={{
                left: `${duration ? (range.start / duration) * 100 : 0}%`,
                width: `${duration ? ((range.end - range.start) / duration) * 100 : 0}%`
              }}
            />
            {poseData?.frames.map((frame, index) => (
              <span
                key={`${frame.time}-${index}`}
                className={frame.landmarks.length ? 'pose-tick detected' : 'pose-tick'}
                style={{ left: `${(index / Math.max(poseData.frames.length - 1, 1)) * 100}%` }}
              />
            ))}
          </div>
        </div>
      </section>

      <aside className="sidebar right-sidebar">
        <section className="panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <span>Reference Mode</span>
          </div>
          <div className="mode-grid">
            {SUBJECT_MODES.map((mode) => (
              <button
                key={mode.key}
                className={subjectMode === mode.key ? 'mode-button active' : 'mode-button'}
                type="button"
                onClick={() => setSubjectMode(mode.key)}
                disabled={isBusy(stage)}
              >
                <strong>{mode.label}</strong>
                <span>{mode.detail}</span>
              </button>
            ))}
          </div>
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
        </section>

        <section className="panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <span>Depth</span>
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
            Smooth frames
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked readOnly />
            High contrast
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
            <SquareStack size={16} />
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
            <Activity size={16} />
            <span>Quality</span>
          </div>
          <div className="quality-score">
            <strong>{qualityReport.score}</strong>
            <span>{qualityReport.readiness}</span>
          </div>
          <div className="metric-grid compact-metrics">
            <Metric label="Track" value={qualityReport.tracking} />
            <Metric label="Camera" value={qualityReport.camera} />
            <Metric label="Layers" value={qualityReport.layers} />
            <Metric label="Pack" value={qualityReport.readiness} />
          </div>
        </section>

        <section className="panel exports-panel">
          <div className="panel-title">
            <Download size={16} />
            <span>Production Pack</span>
          </div>
          <div className="preset-grid">
            {EXPORT_PRESETS.map((preset) => (
              <label key={preset.key} className={exportPresets.includes(preset.key) ? 'chip-toggle selected' : 'chip-toggle'}>
                <input
                  type="checkbox"
                  checked={exportPresets.includes(preset.key)}
                  onChange={() => togglePreset(preset.key)}
                  disabled={isBusy(stage)}
                />
                {preset.label}
              </label>
            ))}
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={useCameraMove} onChange={(event) => setUseCameraMove(event.target.checked)} />
            Camera move
          </label>
          <button className="primary-action" onClick={exportBundle} disabled={!poseData || !analysis || stage === 'exporting'}>
            <Download size={17} />
            Export Pack
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
            <Activity size={16} />
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
    </main>
  );
}

function PreviewPane({
  title,
  tone,
  children
}: {
  title: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`preview-pane ${tone}`}>
      <header>{title}</header>
      <div className="preview-content">{children}</div>
    </article>
  );
}

function EmptyPreview({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <div className="empty-preview">
      {icon}
      <span>{label}</span>
    </div>
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

function ExternalLinkButton({ url, children }: { url: string; children: React.ReactNode }) {
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

function selectPoseFrame(poseData: PoseData | null, time: number): PoseFrame | undefined {
  if (!poseData?.frames.length) return undefined;
  const index = clamp(Math.round(time * poseData.fps), 0, poseData.frames.length - 1);
  return poseData.frames[index];
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
