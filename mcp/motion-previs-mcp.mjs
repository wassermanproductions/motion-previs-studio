#!/usr/bin/env node
// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.

/**
 * Motion Previs Studio MCP server — zero-dependency Node >=18 stdio bridge.
 *
 * Speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (NOT Content-Length framed). Each tools/call is forwarded to the
 * running app's HTTP control server, discovered via
 * the platform config directory's control.json descriptor.
 *
 * Uses only node built-ins + global fetch — run directly with `node`.
 */

import { readFile } from 'node:fs/promises';
import { validateControlDescriptor } from './descriptor.mjs';
import { motionDiscoveryFile } from './config.mjs';

const appPackage = await readAppPackage();
const APP_VERSION = appPackage.version;
const DISCOVERY_FILE = motionDiscoveryFile(appPackage);
const PROTOCOL_VERSION = '2024-11-05';

async function readAppPackage() {
  for (const url of [new URL('../package.json', import.meta.url), new URL('../APP_METADATA.json', import.meta.url)]) {
    try {
      return JSON.parse(await readFile(url, 'utf8'));
    } catch {
      // Source checkout uses package.json; installed builds use APP_METADATA.
    }
  }
  throw new Error('Motion Previs Studio app metadata is missing.');
}

/* --------------------------------- tools -------------------------------- */

// Each tool name maps to a control action of the SAME name; the tool's input
// object is passed through verbatim as that action's params.
const TOOLS = [
  {
    name: 'get_state',
    description:
      'Call FIRST, and poll it during analysis. Returns the current app state: loaded media {name,duration,width,height} or null, the shot range {startS,endS}, the reference mode, analysis settings, and analysis progress { status: idle|running|done|error, stage, progress, poseFrames, detectedFrames, cameraConfidence, qualityScore }, plus lastBundlePath and whether Blockout is running. Workflow: import_file/import_url → set_range/set_mode/set_settings → run_analysis → poll get_state until analysis.status is "done" → export_pack → send_to_blockout. Times are in seconds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'import_file',
    description:
      'Load a local media file (mp4/mov/mkv/webm/…) as the reference shot by absolute path. Validates the file exists and registers it so the app can read it. Replaces any currently loaded media and resets analysis.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to a local video/audio file.' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'import_url',
    description:
      'Download a web video (YouTube or direct http/https link) with yt-dlp and load it as the reference shot. Can take a while for long videos.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'An http or https video URL.' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'set_range',
    description:
      'Set the shot range (the trim window) analysis and export will use, in seconds. endS must be greater than startS. Keep it short (a few seconds) for fast analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        startS: { type: 'number', description: 'Range start in seconds.' },
        endS: { type: 'number', description: 'Range end in seconds.' }
      },
      required: ['startS', 'endS'],
      additionalProperties: false
    }
  },
  {
    name: 'set_mode',
    description:
      'Set the Reference Mode (what to preserve from the reference): camera_only (just camera move + timing), actor_motion (body/pose + camera), object_motion (object/vehicle path + camera), or full_scene (everything).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['camera_only', 'actor_motion', 'object_motion', 'full_scene'],
          description: 'Reference mode.'
        }
      },
      required: ['mode'],
      additionalProperties: false
    }
  },
  {
    name: 'set_settings',
    description:
      'Adjust analysis settings. All fields optional; omitted fields are unchanged. Use a low sampleFps (e.g. 6) and short range for fast test runs.',
    inputSchema: {
      type: 'object',
      properties: {
        sampleFps: { type: 'number', description: 'Analysis sample rate, 4–24 fps.' },
        maxPeople: { type: 'number', description: 'Max people to track, 1–4.' },
        smoothing: { type: 'number', description: 'Motion smoothing, 0–0.95.' },
        detectionConfidence: { type: 'number', description: 'Pose detection confidence, 0.1–0.9.' },
        trackingConfidence: { type: 'number', description: 'Pose tracking confidence, 0.1–0.9.' },
        resolution: { type: 'string', enum: ['auto', '720p'], description: "Export resolution: 'auto' (long-edge) or '720p' (Seedance)." }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run_analysis',
    description:
      'Kick off the full analysis pipeline (prepare → pose → camera solve) on the loaded media over the current range. Returns immediately with { started: true }; poll get_state and wait until analysis.status is "done" before calling export_pack. Requires media to be loaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'export_pack',
    description:
      'Render and save the full production pack (control videos, OpenPose skeleton + keypoints, prompts, shot bible, Blender scripts, and a ZIP). Waits for completion and returns { bundlePath, zipPath }. Requires a completed analysis (get_state analysis.status === "done").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_bundle',
    description: 'List the files in the last exported bundle. Returns { bundlePath, files }. Call export_pack first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'send_to_blockout',
    description:
      'Hand a clip from the last bundle to a running Blockout session as a ghost reference underlay. Choose which layer to send. Requires export_pack to have run and Blockout to be running (see get_state.blockoutAvailable).',
    inputSchema: {
      type: 'object',
      properties: {
        which: {
          type: 'string',
          enum: ['reference', 'depth', 'ai_depth', 'pose', 'openpose'],
          description: 'Which bundle video to send (default reference).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the app window as a PNG image and return it. Use to see the current UI — the loaded shot, previews, and analysis results.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/* ------------------------------ control call ---------------------------- */

const NOT_RUNNING = "Motion Previs Studio isn't running — launch the app first.";

async function callControl(action, params) {
  let config;
  try {
    config = validateControlDescriptor(JSON.parse(await readFile(DISCOVERY_FILE, 'utf-8')));
    if (!config) return { error: NOT_RUNNING };
  } catch {
    return { error: NOT_RUNNING };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({ action, params: params ?? {} })
    });
    return { response: await res.json() };
  } catch {
    return { error: NOT_RUNNING };
  }
}

/* ---------------------------- JSON-RPC plumbing ------------------------- */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (!TOOL_NAMES.has(name)) {
    reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
    return;
  }
  const { response, error } = await callControl(name, args);
  if (error) {
    reply(id, { content: [{ type: 'text', text: error }], isError: true });
    return;
  }
  // Image special-case: an ok screenshot returns base64 PNG data.
  if (response && response.ok && response.data && typeof response.data.imageBase64 === 'string') {
    reply(id, { content: [{ type: 'image', data: response.data.imageBase64, mimeType: 'image/png' }] });
    return;
  }
  reply(id, {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response && response.ok === false
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'motion-previs-studio', version: APP_VERSION }
      });
      return;
    case 'notifications/initialized':
      return; // notification, no reply
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    case 'ping':
      reply(id, {});
      return;
    default:
      // Notifications (no id) are ignored; requests get method-not-found.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

/* ------------------------------- stdin loop ----------------------------- */

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON lines
    }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
