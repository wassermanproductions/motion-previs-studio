import assert from 'node:assert/strict';
import { validateControlDescriptor } from '../mcp/descriptor.mjs';
import { motionDiscoveryFile } from '../mcp/config.mjs';

const token = '0123456789abcdef0123456789abcdef';
assert.deepEqual(
  validateControlDescriptor({ port: 49152, token }),
  { port: 49152, token },
  'legacy descriptors without protocolVersion remain valid'
);
assert.equal(validateControlDescriptor({ protocolVersion: 2, app: 'motion-previs-studio', port: 49152, token }), null);
assert.equal(validateControlDescriptor({ protocolVersion: 1, app: 'blockout', port: 49152, token }), null);
assert.equal(validateControlDescriptor({ protocolVersion: 1, app: 'motion-previs-studio', port: 0, token }), null);
assert.equal(validateControlDescriptor({ protocolVersion: 1, app: 'motion-previs-studio', port: 49152, token: 'short' }), null);
assert.equal(validateControlDescriptor({ protocolVersion: 1, app: 'motion-previs-studio', port: 'http://evil', token }), null);

const winOptions = {
  platform: 'win32',
  env: { APPDATA: 'D:\\Profiles\\Editor\\Roaming' },
  home: 'C:\\Users\\Editor'
};
assert.equal(
  motionDiscoveryFile({ distribution: { configFolder: 'Example Studio/Community/control' } }, winOptions),
  'D:\\Profiles\\Editor\\Roaming\\Example Studio\\Community\\control\\control.json'
);
assert.equal(
  motionDiscoveryFile({}, winOptions),
  'D:\\Profiles\\Editor\\Roaming\\Motion Previs Studio\\v4\\control.json'
);
assert.equal(
  motionDiscoveryFile({}, { ...winOptions, env: { MOTION_PREVIS_CONFIG_DIR: 'E:\\mps-ci' } }),
  'E:\\mps-ci\\control.json'
);
console.log('verify:mcp-descriptor: OK');
