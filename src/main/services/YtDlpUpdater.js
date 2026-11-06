// src/main/services/YtDlpUpdater.js
const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class YtDlpUpdater {
  constructor(options = {}) {
    this.binDir = options.binDir || path.join(os.homedir(), '.config', 'bravedm', 'bin');
    this.checkIntervalMs = options.checkIntervalMs || 1000 * 60 * 60 * 12; // 12 hours
    this.timer = null;
    this.isUpdating = false;
  }

  /**
   * Starts the background updater loop. Performs an initial check 10 seconds after boot.
   */
  start() {
    setTimeout(() => this.checkForUpdates(), 10000);
    this.timer = setInterval(() => this.checkForUpdates(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTargetBinaryPath() {
    const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    return path.join(this.binDir, binaryName);
  }

  async getStatus() {
    const targetBinaryPath = this.getTargetBinaryPath();
    let localVersion = await this._getLocalBinaryVersion(targetBinaryPath);
    let activeBinaryPath = targetBinaryPath;

    if (!localVersion) {
      try {
        const { BinaryResolver } = require('../utils/BinaryResolver');
        activeBinaryPath = BinaryResolver.getBinaryPath('yt-dlp');
        localVersion = await this._getLocalBinaryVersion(activeBinaryPath);
      } catch {}
    }

    return {
      binaryPath: activeBinaryPath,
      localVersion: localVersion || 'Unknown',
      isUpdating: this.isUpdating,
    };
  }

  /**
   * Queries local binary version and compares it against GitHub Releases API.
   * Returns a status object describing the result.
   */
  async checkForUpdates() {
    if (this.isUpdating) {
      return { success: false, message: 'Update check already in progress.' };
    }
    this.isUpdating = true;

    try {
      await fsp.mkdir(this.binDir, { recursive: true });
      const targetBinaryPath = this.getTargetBinaryPath();

      const localVersion = await this._getLocalBinaryVersion(targetBinaryPath);
      console.log(`[YtDlpUpdater] Local yt-dlp version: ${localVersion || 'Not found'}`);

      // Query GitHub Releases API for yt-dlp/yt-dlp
      const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
        headers: { 'User-Agent': 'Brave-DM-Updater' },
      });

      if (!res.ok) throw new Error(`GitHub API responded with HTTP ${res.status}`);
      const releaseData = await res.json();
      const latestVersion = releaseData.tag_name;

      console.log(`[YtDlpUpdater] Latest remote yt-dlp version: ${latestVersion}`);

      if (!localVersion || localVersion !== latestVersion) {
        console.log(`[YtDlpUpdater] New version detected (${latestVersion}). Starting atomic update...`);
        await this._downloadAndReplaceBinary(releaseData, targetBinaryPath);
        console.log('[YtDlpUpdater] Successfully updated yt-dlp binary.');
        return {
          success: true,
          updated: true,
          localVersion: latestVersion,
          latestVersion,
          message: `Updated yt-dlp to latest version ${latestVersion}.`,
        };
      } else {
        console.log('[YtDlpUpdater] yt-dlp is already up to date.');
        return {
          success: true,
          updated: false,
          localVersion,
          latestVersion,
          message: `yt-dlp is already up to date (${localVersion}).`,
        };
      }
    } catch (err) {
      console.error('[YtDlpUpdater] Background update check failed:', err.message);
      return {
        success: false,
        updated: false,
        message: `Update check failed: ${err.message}`,
      };
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Executes local binary with `--version` to read installed release tag.
   */
  _getLocalBinaryVersion(binaryPath) {
    return new Promise((resolve) => {
      if (!fs.existsSync(binaryPath)) return resolve(null);

      const proc = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';

      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        resolve(output.trim().split(/\r?\n/)[0]);
      });
      proc.on('error', () => resolve(null));
    });
  }

  /**
   * Downloads appropriate platform asset and performs an atomic rename replacement.
   */
  async _downloadAndReplaceBinary(releaseData, targetBinaryPath) {
    let assetName = 'yt-dlp_linux';
    if (process.platform === 'darwin') {
      assetName = 'yt-dlp_macos';
    } else if (process.platform === 'win32') {
      assetName = 'yt-dlp.exe';
    } else if (process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'aarch64')) {
      assetName = 'yt-dlp_linux_aarch64';
    }

    const asset = (releaseData.assets || []).find((a) => a.name === assetName);
    if (!asset) {
      throw new Error(`Could not locate asset matching ${assetName} in GitHub release.`);
    }

    const tmpDownloadPath = `${targetBinaryPath}.tmp`;

    console.log(`[YtDlpUpdater] Downloading asset from ${asset.browser_download_url}...`);
    const downloadRes = await fetch(asset.browser_download_url, { redirect: 'follow' });
    if (!downloadRes.ok) throw new Error(`Failed to download binary: HTTP ${downloadRes.status}`);

    const fileStream = fs.createWriteStream(tmpDownloadPath, { mode: 0o755 });
    await pipeline(Readable.fromWeb(downloadRes.body), fileStream);

    // Verify downloaded binary runs correctly before atomic switch
    const verified = await this._getLocalBinaryVersion(tmpDownloadPath);
    if (!verified) {
      await fsp.unlink(tmpDownloadPath).catch(() => {});
      throw new Error('Downloaded binary verification failed execution test.');
    }

    // Atomic replacement: Swap old binary with new tmp binary in a single rename operation
    await fsp.rename(tmpDownloadPath, targetBinaryPath);
    await fsp.chmod(targetBinaryPath, 0o755);
  }
}

module.exports = { YtDlpUpdater };
