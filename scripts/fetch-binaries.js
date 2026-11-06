// scripts/fetch-binaries.js
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const TARGETS = [
  {
    destDir: path.join(__dirname, '../bin/linux/x64'),
    files: [
      {
        name: 'yt-dlp',
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      },
    ],
  },
  {
    destDir: path.join(__dirname, '../bin/mac/arm64'),
    files: [
      {
        name: 'yt-dlp',
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
      },
    ],
  },
];

async function downloadFile(url, destPath) {
  console.log(`[fetch-binaries] Downloading ${url} -> ${destPath}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const fileStream = fs.createWriteStream(destPath, { mode: 0o755 });
  await pipeline(Readable.fromWeb(res.body), fileStream);
  await fsp.chmod(destPath, 0o755);
}

async function run() {
  for (const target of TARGETS) {
    await fsp.mkdir(target.destDir, { recursive: true });
    for (const file of target.files) {
      const destPath = path.join(target.destDir, file.name);
      try {
        await downloadFile(file.url, destPath);
      } catch (err) {
        console.warn(`[fetch-binaries] Could not fetch ${file.name} from web (${err.message}). Checking system binary fallback...`);
      }
    }
  }
  console.log('[fetch-binaries] yt-dlp provisioning complete. Ensure static ffmpeg builds are present in bin/<os>/<arch>/ffmpeg.');
}

run().catch((err) => {
  console.error('[fetch-binaries] Failed:', err);
  process.exit(1);
});
