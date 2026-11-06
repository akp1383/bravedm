// test/workstealing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { DownloadManager } = require('../src/main/engine/DownloadManager');

test('Dynamic Work-Stealing in-flight download execution and assembly verification', async () => {
  // Generate 4MB random test data
  const testData = crypto.randomBytes(4 * 1024 * 1024);
  const dataSha256 = crypto.createHash('sha256').update(testData).digest('hex');

  // Start an HTTP Range-compliant server with artificial throttle on second half of segment 1
  const server = http.createServer((req, res) => {
    const rangeHeader = req.headers.range;
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : testData.length - 1;
    const chunk = testData.subarray(start, end + 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${testData.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk.length,
      'Content-Type': 'application/octet-stream',
    });

    // Send data in 32KB bursts
    let offset = 0;
    const burstSize = 32 * 1024;
    function sendNext() {
      if (offset >= chunk.length) {
        res.end();
        return;
      }
      const nextSlice = chunk.subarray(offset, offset + burstSize);
      offset += nextSlice.length;
      res.write(nextSlice);
      setTimeout(sendNext, 5);
    }
    sendNext();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/large-sample.bin`;

  const tmpDir = path.join(os.tmpdir(), `bravedm-steal-${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const dm = new DownloadManager({ maxConnections: 4, configDir: tmpDir });
  dm.minChunkSize = 256 * 1024; // 256 KB
  await dm.init();

  const completedPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Work-stealing download timed out')), 20000);
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
    filename: 'stolen-sample.bin',
    connections: 4,
  });

  assert.ok(taskId);
  await completedPromise;

  const downloadedPath = path.join(tmpDir, 'stolen-sample.bin');
  const downloadedBuf = await fsp.readFile(downloadedPath);
  const downloadedSha256 = crypto.createHash('sha256').update(downloadedBuf).digest('hex');

  assert.equal(downloadedBuf.length, testData.length);
  assert.equal(downloadedSha256, dataSha256);

  // Clean up
  clearInterval(dm.telemetryInterval);
  server.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});
