import path from 'node:path';
import { homedir } from 'node:os';

export function motionDiscoveryFile(appPackage, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = env.MOTION_PREVIS_CONFIG_DIR || env.MPS_CONFIG_DIR;
  if (override) return p.join(override, 'control.json');
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    if (appPackage.distribution?.configFolder) {
      return path.win32.join(appData, appPackage.distribution.configFolder, 'control.json');
    }
    return path.win32.join(appData, 'Motion Previs Studio', 'v4', 'control.json');
  }
  return path.posix.join(home, '.config', 'motion-previs', 'control.json');
}
