// test/download.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { DownloadManager } = require('../src/main/engine/DownloadManager');

test('End-to-end multi-segment HTTP Range download with file verification', async () => {
  // Generate 2MB random test data
  const testData = crypto.randomBytes(2 * 1024 * 1024);
  const dataSha256 = crypto.createHash('sha256').update(testData).digest('hex');

  // Start a local HTTP Range-compliant server
  const server = http.createServer((req, res) => {
    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.writeHead(200, {
        'Content-Length': testData.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      res.end(testData);
      return;
    }

    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${testData.length}` });
      res.end();
      return;
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : testData.length - 1;
    const chunk = testData.subarray(start, end + 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${testData.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk.length,
      'Content-Type': 'application/octet-stream',
    });
    res.end(chunk);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/test-file.bin`;

  const tmpDir = path.join(os.tmpdir(), `bravedm-e2e-${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const dm = new DownloadManager({ maxConnections: 4 });
  dm.minChunkSize = 256 * 1024; // 256 KB for test
  await dm.init();

  const completedPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Download timed out')), 10000);
    dm.once('task:completed', (t) => {
      clearTimeout(timeout);
      resolve(t);
    });
    dm.once('task:error', (t) => {
      clearTimeout(timeout);
      reject(new Error(t.error));
    });
  });

  const taskId = await dm.createTask({
    url: testUrl,
    saveDir: tmpDir,
    filename: 'downloaded-sample.bin',
    connections: 4,
  });

  assert.ok(taskId);
  await completedPromise;

  const downloadedPath = path.join(tmpDir, 'downloaded-sample.bin');
  const downloadedBuf = await fsp.readFile(downloadedPath);
  const downloadedSha256 = crypto.createHash('sha256').update(downloadedBuf).digest('hex');

  assert.equal(downloadedBuf.length, testData.length);
  assert.equal(downloadedSha256, dataSha256);

  // Clean up
  clearInterval(dm.telemetryInterval);
  server.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});
