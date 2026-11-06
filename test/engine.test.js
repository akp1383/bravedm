// test/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { DownloadManager } = require('../src/main/engine/DownloadManager');
const { MediaProber } = require('../src/main/services/MediaProber');
const { BinaryResolver } = require('../src/main/utils/BinaryResolver');
const { AtomicStore } = require('../src/main/utils/AtomicStore');

test('AtomicStore reads, writes and persists atomically', async () => {
  const tmpDir = path.join(os.tmpdir(), `bravedm-test-${Date.now()}`);
  const filePath = path.join(tmpDir, 'test-state.json');
  const store = new AtomicStore(filePath);

  const initial = await store.read({ empty: true });
  assert.equal(initial.empty, true);

  const payload = { hello: 'world', version: 1 };
  await store.saveImmediate(payload);

  const retrieved = await store.read({});
  assert.deepEqual(retrieved, payload);

  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('DownloadManager segments partitioning logic', async () => {
  const dm = new DownloadManager();

  // 10 MB total size, 16 connections
  const totalBytes = 10 * 1024 * 1024;
  const task = { totalBytes, nextSegmentId: 0 };
  const segments = dm._buildInitialSegments(task, 16);

  assert.equal(segments.length, 16);
  assert.equal(segments[0].startByte, 0);
  assert.equal(segments[segments.length - 1].endByte, totalBytes - 1);

  // Check contiguity
  for (let i = 0; i < segments.length - 1; i++) {
    assert.equal(segments[i].endByte + 1, segments[i + 1].startByte);
  }
});

test('Dynamic Work-Stealing in-flight chunk splitting', async () => {
  const dm = new DownloadManager();

  // Create a simulated task with 2 segments
  const task = {
    id: 'test-task',
    totalBytes: 4 * 1024 * 1024, // 4 MB
    nextSegmentId: 2,
    supportsRanges: true,
    segments: [
      {
        id: 0,
        startByte: 0,
        currentOffset: 2 * 1024 * 1024 - 1, // nearly done
        endByte: 2 * 1024 * 1024 - 1,
        status: 'active',
      },
      {
        id: 1,
        startByte: 2 * 1024 * 1024,
        currentOffset: 2 * 1024 * 1024, // has 2 MB remaining
        endByte: 4 * 1024 * 1024 - 1,
        status: 'active',
      },
    ],
  };

  // Remaining in seg 1 is 2 MB. It is >= 2 * 512KB (1MB).
  // Stealing work should split segment 1 into two 1MB pieces.
  const stolen = dm._tryStealWork(task);
  assert.notEqual(stolen, null);
  assert.equal(stolen.stolen, true);

  // Segment 1 should be truncated to midpoint
  const seg1 = task.segments.find((s) => s.id === 1);
  assert.equal(seg1.endByte + 1, stolen.startByte);
  assert.equal(stolen.endByte, 4 * 1024 * 1024 - 1);
});

test('MediaProber metadata normalization', () => {
  const prober = new MediaProber();
  const rawInfo = {
    id: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up',
    uploader: 'RickAstleyVEVO',
    duration: 213,
    thumbnail: 'https://example.com/thumb.jpg',
    webpage_url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    formats: [
      { format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080, tbr: 4500, filesize: 50000000 },
      { format_id: '136', vcodec: 'avc1', acodec: 'none', height: 720, tbr: 2500, filesize: 25000000 },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 3500000 },
    ],
  };

  const normalized = prober._normalizeMetadata(rawInfo, rawInfo.webpage_url);
  assert.equal(normalized.id, 'dQw4w9WgXcQ');
  assert.equal(normalized.title, rawInfo.title);
  assert.equal(normalized.durationFormatted, '03:33');

  // Should have 1080p, 720p, and audio presets
  const p1080 = normalized.presets.find((p) => p.presetId === '1080p');
  assert.ok(p1080);
  assert.equal(p1080.requiresMuxing, true);
  assert.ok(p1080.formatSelector.includes('137+140'));

  const pAudio = normalized.presets.find((p) => p.presetId === 'audio');
  assert.ok(pAudio);
  assert.equal(pAudio.requiresMuxing, false);
});

test('BinaryResolver finds system yt-dlp and ffmpeg', () => {
  const ytDlpPath = BinaryResolver.getBinaryPath('yt-dlp');
  const ffmpegPath = BinaryResolver.getBinaryPath('ffmpeg');
  assert.ok(ytDlpPath);
  assert.ok(ffmpegPath);
});
