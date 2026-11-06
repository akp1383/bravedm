// src/main/services/MediaProber.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

class MediaProber {
  constructor(options = {}) {
    this.ytDlpPath = options.ytDlpPath || 'yt-dlp';
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
  }

  getYtDlpPath() {
    try {
      const { BinaryResolver } = require('../utils/BinaryResolver');
      return BinaryResolver.getBinaryPath('yt-dlp');
    } catch {
      return this.ytDlpPath || 'yt-dlp';
    }
  }

  getFfmpegPath() {
    try {
      const { BinaryResolver } = require('../utils/BinaryResolver');
      return BinaryResolver.getBinaryPath('ffmpeg');
    } catch {
      return this.ffmpegPath || 'ffmpeg';
    }
  }

  /**
   * Probes a media URL via `yt-dlp --dump-single-json` and normalizes
   * available formats into 4K, 1080p, 720p, and Audio-Only presets.
   *
   * @param {string} targetUrl
   * @param {number} timeoutMs
   * @returns {Promise<Object>}
   */
  async probeUrl(targetUrl, timeoutMs = 25000) {
    const currentYtDlp = this.getYtDlpPath();
    return new Promise((resolve, reject) => {
      const args = [
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--geo-bypass',
        targetUrl,
      ];

      const proc = spawn(currentYtDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks = [];
      const stderrChunks = [];

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Media probe timed out after 25 seconds.'));
      }, timeoutMs);

      proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn yt-dlp binary (${this.ytDlpPath}): ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const errText = Buffer.concat(stderrChunks).toString('utf-8').trim();
          return reject(new Error(errText || `yt-dlp exited with code ${code}`));
        }

        try {
          const rawJson = Buffer.concat(stdoutChunks).toString('utf-8');
          const info = JSON.parse(rawJson);
          resolve(this._normalizeMetadata(info, targetUrl));
        } catch (parseErr) {
          reject(new Error(`Failed to parse yt-dlp metadata: ${parseErr.message}`));
        }
      });
    });
  }

  /**
   * Transforms raw yt-dlp JSON output into structured UI resolution tiers.
   *
   * @param {Object} info
   * @param {string} originalUrl
   * @returns {Object}
   */
  _normalizeMetadata(info, originalUrl) {
    const formats = Array.isArray(info.formats) ? info.formats : [];

    // Helper to locate best video stream matching a target height
    const findBestVideoForHeight = (targetHeight) => {
      const candidates = formats.filter(
        (f) => f.vcodec && f.vcodec !== 'none' && (f.height === targetHeight || (f.height && Math.abs(f.height - targetHeight) <= 40))
      );
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
      return candidates[0];
    };

    const bestAudio = formats
      .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

    const presets = [];

    const tiers = [
      { id: '4k', label: '4K Ultra HD (2160p)', height: 2160 },
      { id: '1080p', label: 'Full HD (1080p)', height: 1080 },
      { id: '720p', label: 'HD (720p)', height: 720 },
    ];

    const duration = info.duration || 0;

    for (const tier of tiers) {
      const match = findBestVideoForHeight(tier.height);
      if (match) {
        const needsMux = !match.acodec || match.acodec === 'none';
        const videoBytes = match.filesize || match.filesize_approx ||
          (match.tbr && duration ? Math.round((match.tbr * 1000 / 8) * duration) : 0);
        const audioBytes = bestAudio
          ? (bestAudio.filesize || bestAudio.filesize_approx ||
             (bestAudio.tbr && duration ? Math.round((bestAudio.tbr * 1000 / 8) * duration) : 0))
          : 0;
        const approxSize = videoBytes + (needsMux ? audioBytes : 0);

        presets.push({
          presetId: tier.id,
          label: tier.label,
          ext: 'mp4',
          formatSelector: needsMux
            ? `${match.format_id}+${bestAudio ? bestAudio.format_id : 'bestaudio'}/best[height<=${tier.height}]`
            : match.format_id,
          directUrl: !needsMux ? match.url : null,
          requiresMuxing: needsMux,
          estimatedBytes: approxSize,
          fps: match.fps || 30,
        });
      }
    }

    // Fallback: If no tiers matched but there are combined formats (e.g. standard MP4)
    if (presets.length === 0) {
      const bestGeneric = formats
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (bestGeneric) {
        const approxSize = bestGeneric.filesize || bestGeneric.filesize_approx ||
          (bestGeneric.tbr && duration ? Math.round((bestGeneric.tbr * 1000 / 8) * duration) : 0);
        presets.push({
          presetId: 'best',
          label: `Standard Video (${bestGeneric.height || 720}p)`,
          ext: bestGeneric.ext || 'mp4',
          formatSelector: bestGeneric.format_id,
          directUrl: bestGeneric.url || null,
          requiresMuxing: false,
          estimatedBytes: approxSize,
          fps: bestGeneric.fps || 30,
        });
      }
    }

    // Always append Audio-Only option if available
    if (bestAudio) {
      presets.push({
        presetId: 'audio',
        label: `Audio Only (${(bestAudio.acodec || 'AAC').toUpperCase()} - ${Math.round(bestAudio.abr || 128)} kbps)`,
        ext: 'm4a',
        formatSelector: `${bestAudio.format_id}/bestaudio`,
        directUrl: bestAudio.url || null,
        requiresMuxing: false,
        estimatedBytes: bestAudio.filesize || bestAudio.filesize_approx || 0,
        fps: null,
      });
    }

    let thumbUrl = info.thumbnail || null;
    if (!thumbUrl && Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
      thumbUrl = info.thumbnails[info.thumbnails.length - 1].url;
    }

    return {
      id: info.id || `media_${Date.now()}`,
      title: info.title || 'Untitled Media',
      uploader: info.uploader || info.channel || 'Unknown Creator',
      durationSeconds: info.duration || 0,
      durationFormatted: this._formatDuration(info.duration || 0),
      thumbnail: thumbUrl,
      webpageUrl: info.webpage_url || originalUrl,
      presets,
    };
  }

  /**
   * Spawns a high-speed yt-dlp download with concurrent fragments and parses
   * stdout progress lines in real time.
   *
   * @param {Object} options
   * @param {string} options.url
   * @param {string} options.formatSelector
   * @param {string} options.outputPath
   * @param {number} [options.concurrentFragments=32]
   * @param {Function} [options.onProgress]
   * @returns {Promise<string>}
   */
  downloadMediaStream({ url, formatSelector, outputPath, concurrentFragments = 64, onProgress }) {
    const currentYtDlp = this.getYtDlpPath();
    const currentFfmpeg = this.getFfmpegPath();
    return new Promise((resolve, reject) => {
      const args = [
        '--no-playlist',
        '--newline',
        '--concurrent-fragments', String(concurrentFragments),
        '-f', formatSelector,
        '--merge-output-format', outputPath.endsWith('.m4a') ? 'm4a' : 'mp4',
        '--ffmpeg-location', currentFfmpeg,
        '-o', outputPath,
        url,
      ];

      const proc = spawn(currentYtDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrLog = '';

      proc.stdout.on('data', (data) => {
        const lines = data.toString('utf-8').split(/\r?\n/);
        for (const line of lines) {
          // Standard yt-dlp format: [download]  45.2% of 120.50MiB at 12.40MiB/s ETA 00:05
          const matchFull = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?([\d.]+)(\w+)\s+at\s+([\d.]+)(\w+\/s)/i);
          if (matchFull && onProgress) {
            onProgress({
              percent: parseFloat(matchFull[1]),
              totalSizeStr: `${matchFull[2]} ${matchFull[3]}`,
              speedStr: `${matchFull[4]} ${matchFull[5]}`,
            });
            continue;
          }

          // Simpler percentage match: [download]  50.0% of ~50.00MiB
          const matchSimple = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
          if (matchSimple && onProgress) {
            onProgress({
              percent: parseFloat(matchSimple[1]),
            });
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderrLog += data.toString('utf-8');
      });

      proc.on('close', async (code) => {
        if (code !== 0) {
          return reject(new Error(stderrLog.trim() || `yt-dlp process exited with code ${code}`));
        }

        // Explicitly flush file descriptor after muxing completes
        try {
          const fh = await fs.open(outputPath, 'r+');
          await fh.sync();
          await fh.close();
          resolve(outputPath);
        } catch (flushErr) {
          // If file is closed or missing
          resolve(outputPath);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`yt-dlp process failed to start: ${err.message}`));
      });
    });
  }

  _formatDuration(totalSeconds) {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    return [
      hrs > 0 ? String(hrs).padStart(2, '0') : null,
      String(mins).padStart(2, '0'),
      String(secs).padStart(2, '0'),
    ].filter(Boolean).join(':');
  }
}

module.exports = { MediaProber };
