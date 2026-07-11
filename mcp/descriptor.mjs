export function validateControlDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof value.token !== 'string' || value.token.length < 16) return null;
  if (value.protocolVersion !== undefined && value.protocolVersion !== 1) return null;
  if (value.app !== undefined && value.app !== 'motion-previs-studio') return null;
  return { ...value, port };
}
