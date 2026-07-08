/**
 * Renderer side of the agent control server (see electron/control.cjs and
 * mcp/motion-previs-mcp.mjs). External agents — Claude Code, Codex, Hermes, any
 * MCP client — drive the app through this whitelist of actions, executed
 * against the same App state/flows the UI uses via the window.__mps surface.
 */

import type { SubjectMode } from '../types';
import type { ControlSettingsPatch, SendToBlockoutWhich } from './registry';

type Params = Record<string, unknown>;
type ControlResult = { ok: boolean; data?: unknown; error?: string };

const VALID_MODES: SubjectMode[] = ['camera-only', 'actor-motion', 'object-motion', 'full-scene'];
const VALID_WHICH: SendToBlockoutWhich[] = ['reference', 'depth', 'ai_depth', 'pose', 'openpose'];

const num = (p: Params, k: string): number | undefined =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : undefined;
const str = (p: Params, k: string): string | undefined =>
  typeof p[k] === 'string' ? (p[k] as string) : undefined;

function surface() {
  const s = window.__mps;
  if (!s) throw new Error('The app is still starting up — try again in a moment.');
  return s;
}

async function execute(action: string, params: Params): Promise<unknown> {
  const mps = surface();
  switch (action) {
    case 'get_state':
      return mps.getState();

    case 'import_file': {
      const path = str(params, 'path');
      if (!path) throw new Error('import_file requires a "path" to a local media file.');
      return mps.importFile(path);
    }

    case 'import_url': {
      const url = str(params, 'url');
      if (!url) throw new Error('import_url requires a "url".');
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http or https link.');
      return mps.importUrl(url);
    }

    case 'set_range': {
      const startS = num(params, 'startS');
      const endS = num(params, 'endS');
      if (startS === undefined || endS === undefined) {
        throw new Error('set_range requires numeric "startS" and "endS" (seconds).');
      }
      if (endS <= startS) throw new Error('endS must be greater than startS.');
      return mps.setRange(startS, endS);
    }

    case 'set_mode': {
      // The MCP surface spells modes with underscores (camera_only); the app's
      // SubjectMode uses hyphens. Accept either.
      const mode = str(params, 'mode')?.replace(/_/g, '-') as SubjectMode | undefined;
      if (!mode || !VALID_MODES.includes(mode)) {
        throw new Error(`mode must be one of ${VALID_MODES.join(', ')} (underscores accepted).`);
      }
      return mps.setMode(mode);
    }

    case 'set_settings': {
      const patch: ControlSettingsPatch = {};
      const sampleFps = num(params, 'sampleFps');
      const maxPeople = num(params, 'maxPeople');
      const smoothing = num(params, 'smoothing');
      const detectionConfidence = num(params, 'detectionConfidence');
      const trackingConfidence = num(params, 'trackingConfidence');
      const resolution = str(params, 'resolution');
      if (sampleFps !== undefined) patch.sampleFps = sampleFps;
      if (maxPeople !== undefined) patch.maxPeople = maxPeople;
      if (smoothing !== undefined) patch.smoothing = smoothing;
      if (detectionConfidence !== undefined) patch.detectionConfidence = detectionConfidence;
      if (trackingConfidence !== undefined) patch.trackingConfidence = trackingConfidence;
      if (resolution !== undefined) {
        if (resolution !== 'auto' && resolution !== '720p') {
          throw new Error("resolution must be 'auto' or '720p'.");
        }
        patch.resolution = resolution;
      }
      return mps.setSettings(patch);
    }

    case 'run_analysis':
      return mps.runAnalysis();

    case 'export_pack':
      return mps.exportPack();

    case 'list_bundle':
      return mps.listBundle();

    case 'send_to_blockout': {
      const which = (str(params, 'which') ?? 'reference') as SendToBlockoutWhich;
      if (!VALID_WHICH.includes(which)) {
        throw new Error(`which must be one of ${VALID_WHICH.join(', ')}.`);
      }
      return mps.sendToBlockout(which);
    }

    case 'screenshot':
      // Handled main-side (webContents.capturePage); should never reach here.
      throw new Error('screenshot is handled by the main process.');

    default:
      throw new Error(`Unknown action "${action}".`);
  }
}

/** Wire up control-invoke handling. Returns an unsubscribe for teardown. */
export function registerControlHandler(): () => void {
  if (!window.motionPrevis?.onControlInvoke) return () => undefined;
  return window.motionPrevis.onControlInvoke((id, action, params) => {
    void (async () => {
      let result: ControlResult;
      try {
        const data = await execute(action, (params ?? {}) as Params);
        result = { ok: true, data };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      window.motionPrevis?.controlResult(id, result);
    })();
  });
}
