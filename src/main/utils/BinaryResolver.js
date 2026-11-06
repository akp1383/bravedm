// src/main/utils/BinaryResolver.js
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

class BinaryResolver {
  /**
   * Resolves the absolute path to a bundled binary ('yt-dlp' or 'ffmpeg')
   * across packaged production, user config directory, local workspace, and system PATH.
   *
   * @param {string} binaryName
   * @returns {string}
   */
  static getBinaryPath(binaryName) {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? `${binaryName}.exe` : binaryName;

    // 1. Packaged Production Build (process.resourcesPath/bin/)
    if (app && app.isPackaged) {
      const prodPath = path.join(process.resourcesPath, 'bin', exeName);
      if (fs.existsSync(prodPath)) {
        return prodPath;
      }
    }

    // 2. Updated binary in user config directory (~/.config/bravedm/bin/)
    const userBinDir = path.join(os.homedir(), '.config', 'bravedm', 'bin');
    const userBinPath = path.join(userBinDir, exeName);
    if (fs.existsSync(userBinPath)) {
      return userBinPath;
    }

    // 3. Local Development Workspace (bin/{linux|mac}/{x64|arm64}/)
    const osFolder = process.platform === 'darwin' ? 'mac' : process.platform;
    const baseAppPath = app ? app.getAppPath() : path.resolve(__dirname, '../../../');
    const devPath = path.join(baseAppPath, 'bin', osFolder, process.arch, exeName);
    if (fs.existsSync(devPath)) {
      return devPath;
    }

    // 4. Fallback to system PATH (e.g. /usr/bin/yt-dlp, /usr/bin/ffmpeg)
    try {
      const whichCmd = isWin ? `where ${exeName}` : `which ${exeName}`;
      const found = execSync(whichCmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found)) {
        return found;
      }
    } catch {
      // Ignored: fallback to bare name
    }

    return exeName;
  }
}

module.exports = { BinaryResolver };
