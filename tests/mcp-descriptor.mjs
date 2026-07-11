import assert from 'node:assert/strict';
import { validateControlDescriptor } from '../mcp/descriptor.mjs';

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
console.log('verify:mcp-descriptor: OK');
