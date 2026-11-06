// src/main/engine/DownloadManager.js
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SegmentWorker } = require('./SegmentWorker');

class DownloadManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.configDir = options.configDir || path.join(os.homedir(), '.config', 'bravedm');
    this.stateFile = options.stateFile || path.join(this.configDir, 'state.json');
    this.defaultConnections = options.maxConnections || 64; // Default to 64 parallel connections
    this.minChunkSize = 1024 * 512; // 512 KB minimum split threshold

    /** @type {Map<string, Object>} Serialized task metadata */
    this.tasks = new Map();
    /** @type {Map<string, Map<number, AbortController>>} Active HTTP abort controllers per task/segment */
    this.activeControllers = new Map();
    /** @type {Map<string, Object>} Speed calculation ring buffers */
    this.speedTrackers = new Map();

    this.saveTimeout = null;
    this.isShuttingDown = false;
    this.telemetryInterval = null;
  }

  /**
   * Initializes config directory, loads persisted state, and downgrades
   * any previously 'downloading' or 'probing' tasks to 'paused' for safe recovery.
   */
  async init() {
    await fsp.mkdir(this.configDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      for (const task of parsed.tasks || []) {
        if (task.status === 'downloading' || task.status === 'probing') {
          task.status = 'paused';
        }
        if (task.segments && task.segments.length > 0) {
          const sum = task.segments.reduce((acc, s) => acc + Math.max(0, (s.currentOffset || s.startByte) - s.startByte), 0);
          if (sum > 0) task.downloadedBytes = sum;
        }
        if (task.status === 'completed' && task.totalBytes > 0) {
          task.downloadedBytes = task.totalBytes;
        }
        this.tasks.set(task.id, task);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[DownloadManager] State recovery warning:', err.message);
      }
      await this._persistStateImmediate();
    }

    // 250ms high-frequency telemetry tick for smooth 60fps UI visualizer updates
    this.telemetryInterval = setInterval(() => this._broadcastTelemetry(), 250);
  }

  destroy() {
    this.isShuttingDown = true;
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  scheduleSave() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this._persistStateImmediate();
    }, 1000);
  }

  async _persistStateImmediate() {
    const tmpFile = `${this.stateFile}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    const payload = JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      tasks: Array.from(this.tasks.values()),
    }, null, 2);

    try {
      await fsp.mkdir(this.configDir, { recursive: true });
      const fh = await fsp.open(tmpFile, 'w');
      await fh.writeFile(payload, 'utf-8');
      await fh.sync();
      await fh.close();

      await fsp.rename(tmpFile, this.stateFile);
    } catch (err) {
      console.error('[DownloadManager] Atomic state write failed:', err);
      await fsp.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Creates and starts a new segmented HTTP download task.
   */
  async createTask({ url, saveDir, filename, connections = this.defaultConnections, headers = {}, meta = {} }) {
    const id = crypto.randomUUID();
    const clampedConnections = Math.min(Math.max(connections, 1), 64);

    const task = {
      id,
      url,
      saveDir,
      filename: filename || this._extractFilenameFromUrl(url),
      partPath: '',
      finalPath: '',
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      supportsRanges: false,
      connections: clampedConnections,
      status: 'probing', // probing | downloading | paused | completed | error
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      headers,
      meta,
      nextSegmentId: 0,
      segments: [],
    };

    this.tasks.set(id, task);
    this.emit('task:created', this._sanitizeTaskForUI(task));
    this.scheduleSave();

    try {
      await this._probeAndInitializeTask(task);
      // Launch downloading in background worker pool so createTask returns immediately
      this.startTask(id).catch((err) => {
        this._failTask(task, err.message);
      });
    } catch (err) {
      this._failTask(task, err.message);
    }

    return id;
  }

  /**
   * Registers an externally managed media mux task (e.g. yt-dlp DASH video+audio download).
   */
  registerExternalTask({ id, filename, saveDir, totalBytes = 0, meta = {} }) {
    const task = {
      id,
      url: meta.url || '',
      saveDir,
      filename,
      partPath: '',
      finalPath: path.join(saveDir, filename),
      totalBytes,
      downloadedBytes: 0,
      speedBps: 0,
      supportsRanges: false,
      connections: 64,
      status: 'downloading',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      headers: {},
      meta,
      nextSegmentId: 0,
      segments: [],
    };

    this.tasks.set(id, task);
    this.emit('task:created', this._sanitizeTaskForUI(task));
    this.scheduleSave();
    return task;
  }

  /**
   * Negotiates file size, range support, and pre-allocates the .bravedm.part file.
   */
  async _probeAndInitializeTask(task) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      // Request bytes=0-0 to simultaneously test range support and retrieve total size
      const res = await fetch(task.url, {
        method: 'GET',
        headers: { ...task.headers, Range: 'bytes=0-0' },
        signal: controller.signal,
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Server responded with HTTP ${res.status}`);
      }

      // Resolve filename from Content-Disposition if available
      const disposition = res.headers.get('content-disposition');
      if (disposition && !task.meta.lockedFilename) {
        const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
        if (match && match[1]) {
          let rawName = match[1].trim().replace(/^["']|["']$/g, '');
          try {
            rawName = decodeURIComponent(rawName);
          } catch {}
          const sanitized = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
          if (sanitized) {
            task.filename = sanitized;
          }
        }
      }

      // If Content-Disposition was not present or didn't set a real name, try redirected final URL
      if ((!task.filename || task.filename.startsWith('bravedm_')) && res.url) {
        const fromFinalUrl = this._extractFilenameFromUrl(res.url);
        if (fromFinalUrl && !fromFinalUrl.startsWith('bravedm_')) {
          task.filename = fromFinalUrl;
        }
      }

      const contentRange = res.headers.get('content-range'); // e.g., "bytes 0-0/104857600"
      const acceptRanges = res.headers.get('accept-ranges');

      if (res.status === 206 && contentRange && contentRange.includes('/')) {
        const total = parseInt(contentRange.split('/')[1], 10);
        if (!Number.isNaN(total) && total > 0) {
          task.totalBytes = total;
          task.supportsRanges = true;
        }
      } else {
        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        task.totalBytes = Number.isNaN(contentLength) ? 0 : contentLength;
        task.supportsRanges = acceptRanges === 'bytes' && task.totalBytes > 0;
      }

      if (res.body) await res.body.cancel().catch(() => {});

      await fsp.mkdir(task.saveDir, { recursive: true });
      task.finalPath = await this._resolveUniqueFilePath(path.join(task.saveDir, task.filename));
      task.filename = path.basename(task.finalPath);
      task.partPath = `${task.finalPath}.bravedm.part`;

      // Broadcast updated real filename to UI immediately
      this.emit('task:updated', this._sanitizeTaskForUI(task));

      // Pre-create and allocate the .bravedm.part container on disk
      const fh = await fsp.open(task.partPath, 'w');
      if (task.totalBytes > 0) {
        await fh.truncate(task.totalBytes);
      }
      await fh.sync();
      await fh.close();

      task.segments = this._buildInitialSegments(task, task.supportsRanges ? task.connections : 1);
      await this._persistStateImmediate();
    } finally {
      clearTimeout(timeout);
    }
  }

  _buildInitialSegments(task, desiredConnections) {
    const totalBytes = task.totalBytes;
    if (!totalBytes || totalBytes <= 0 || desiredConnections === 1) {
      return [{
        id: task.nextSegmentId++,
        startByte: 0,
        currentOffset: 0,
        endByte: totalBytes ? totalBytes - 1 : -1,
        status: 'pending',
        stolen: false,
      }];
    }

    const maxPossibleChunks = Math.max(1, Math.floor(totalBytes / this.minChunkSize));
    const numChunks = Math.min(desiredConnections, maxPossibleChunks);
    const chunkSize = Math.floor(totalBytes / numChunks);
    const segments = [];

    for (let i = 0; i < numChunks; i++) {
      const startByte = i * chunkSize;
      const endByte = i === numChunks - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
      segments.push({
        id: task.nextSegmentId++,
        startByte,
        currentOffset: startByte,
        endByte,
        status: 'pending',
        stolen: false,
      });
    }
    return segments;
  }

  /**
   * Orchestrates a dynamic worker pool of up to `task.connections` concurrent workers.
   * Whenever a worker completes its segment, it attempts to claim a pending segment
   * or steal half of the largest remaining in-flight segment.
   */
  async startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'downloading' || task.status === 'completed') return;

    try {
      await fsp.access(task.partPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      await this._probeAndInitializeTask(task);
    }

    // Reset lingering 'active' or 'error' statuses from previous session to 'pending'
    for (const seg of task.segments) {
      if (seg.status === 'active' || seg.status === 'error') {
        seg.status = 'pending';
      }
    }

    task.status = 'downloading';
    task.error = null;
    this.activeControllers.set(taskId, new Map());
    this.speedTrackers.set(taskId, { lastBytes: task.downloadedBytes, lastTick: Date.now() });

    this.emit('task:updated', this._sanitizeTaskForUI(task));
    this.scheduleSave();

    const maxWorkers = task.supportsRanges ? task.connections : 1;
    const workerPool = [];

    for (let w = 0; w < maxWorkers; w++) {
      workerPool.push(this._runWorkerLoop(task));
    }

    try {
      await Promise.all(workerPool);
      if (task.status === 'downloading') {
        await this._finalizeTask(task);
      }
    } catch (err) {
      if (task.status === 'paused') return;
      this._failTask(task, err.message);
    } finally {
      this.activeControllers.delete(taskId);
      this.speedTrackers.delete(taskId);
    }
  }

  /**
   * Worker loop: claims pending segments first; when none remain, invokes
   * dynamic work-stealing to split slow/large active segments in half.
   */
  async _runWorkerLoop(task) {
    while (task.status === 'downloading') {
      // 1. Look for an unclaimed pending segment
      let segment = task.segments.find((s) => s.status === 'pending');

      // 2. If no pending segments exist, attempt in-flight work-stealing
      if (!segment && task.supportsRanges) {
        segment = this._tryStealWork(task);
      }

      // 3. No pending segments and no splittable active segments -> worker exits
      if (!segment) return;

      await SegmentWorker.downloadWithRetry({
        task,
        segment,
        activeControllers: this.activeControllers,
        scheduleSave: () => this.scheduleSave(),
        maxRetries: 5,
      });
    }
  }

  /**
   * IDM-Style Dynamic Work-Stealing:
   * Finds the active segment with the largest remaining byte range.
   * If remaining bytes >= 2 * minChunkSize (1MB), halves its `endByte` in-place
   * without dropping its TCP connection, and returns a new segment for the second half.
   */
  _tryStealWork(task) {
    let largestSegment = null;
    let maxRemaining = 0;

    for (const seg of task.segments) {
      if (seg.status === 'active' && seg.endByte > seg.currentOffset) {
        const remaining = seg.endByte - seg.currentOffset + 1;
        if (remaining > maxRemaining) {
          maxRemaining = remaining;
          largestSegment = seg;
        }
      }
    }

    // Only split if both resulting halves will be at least `minChunkSize` (512 KB)
    if (!largestSegment || maxRemaining < this.minChunkSize * 2) {
      return null;
    }

    const originalEndByte = largestSegment.endByte;
    const splitPoint = largestSegment.currentOffset + Math.floor(maxRemaining / 2) - 1;

    // Mutate the active segment's upper bound in-place!
    // Its Byte-Boundary Transform stream will automatically stop & close cleanly at `splitPoint`.
    largestSegment.endByte = splitPoint;

    const stolenSegment = {
      id: task.nextSegmentId++,
      startByte: splitPoint + 1,
      currentOffset: splitPoint + 1,
      endByte: originalEndByte,
      status: 'pending',
      stolen: true,
    };

    task.segments.push(stolenSegment);
    // Keep segments sorted by physical file offset for the UI visualizer
    task.segments.sort((a, b) => a.startByte - b.startByte);

    this.scheduleSave();
    return stolenSegment;
  }

  /**
   * Pauses an active task by aborting all in-flight segment controllers and flushing state.
   */
  async pauseTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'downloading') return;

    task.status = 'paused';
    task.speedBps = 0;

    const controllers = this.activeControllers.get(taskId);
    if (controllers) {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    }

    await this._persistStateImmediate();
    this.emit('task:updated', this._sanitizeTaskForUI(task));
  }

  /**
   * Deletes a task and optionally cleans up part or final files on disk.
   */
  async deleteTask(taskId, deleteDiskFiles = false) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (task.status === 'downloading') {
      await this.pauseTask(taskId);
    }

    this.tasks.delete(taskId);
    this.activeControllers.delete(taskId);
    this.speedTrackers.delete(taskId);

    if (deleteDiskFiles) {
      if (task.partPath) {
        await fsp.unlink(task.partPath).catch(() => {});
      }
      if (task.finalPath) {
        await fsp.unlink(task.finalPath).catch(() => {});
        await fsp.unlink(`${task.finalPath}.part`).catch(() => {});
        await fsp.unlink(`${task.finalPath}.ytdl`).catch(() => {});
      }
    }

    await this._persistStateImmediate();
    this.emit('task:deleted', taskId);
  }

  /**
   * Clears all completed download tasks from the queue and state.
   */
  async clearCompletedTasks() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    const completedIds = [];
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'completed') {
        completedIds.push(id);
      }
    }

    for (const id of completedIds) {
      this.tasks.delete(id);
      this.activeControllers.delete(id);
      this.speedTrackers.delete(id);
      this.emit('task:deleted', id);
    }

    await this._persistStateImmediate();
    return completedIds;
  }

  /**
   * Flushes OS file buffers via fsync, verifies byte integrity, and renames .bravedm.part to finalPath.
   */
  async _finalizeTask(task) {
    if (task.status !== 'downloading') return;

    // 1. Force OS kernel buffer flush to physical disk
    const fh = await fsp.open(task.partPath, 'r+');
    try {
      await fh.sync();
      const stat = await fh.stat();
      if (task.totalBytes > 0 && stat.size !== task.totalBytes) {
        throw new Error(`Integrity check failed: expected ${task.totalBytes} bytes, got ${stat.size}`);
      }
    } finally {
      await fh.close();
    }

    // 2. Rename .bravedm.part to final destination file
    await fsp.rename(task.partPath, task.finalPath);

    try {
      const stat = await fsp.stat(task.finalPath);
      task.totalBytes = stat.size;
      task.downloadedBytes = stat.size;
    } catch {}

    task.status = 'completed';
    task.speedBps = 0;
    task.completedAt = Date.now();

    await this._persistStateImmediate();
    this.emit('task:completed', this._sanitizeTaskForUI(task));
  }

  _failTask(task, errorMessage) {
    task.status = 'error';
    task.error = errorMessage;
    task.speedBps = 0;
    this._persistStateImmediate();
    this.emit('task:error', this._sanitizeTaskForUI(task));
  }

  _broadcastTelemetry() {
    const activeUpdates = [];
    const now = Date.now();

    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'downloading') continue;

      const tracker = this.speedTrackers.get(id);
      if (tracker) {
        const elapsedSec = (now - tracker.lastTick) / 1000;
        if (elapsedSec >= 0.2) {
          const deltaBytes = task.downloadedBytes - tracker.lastBytes;
          const instantSpeed = deltaBytes / elapsedSec;
          task.speedBps = Math.round(task.speedBps * 0.65 + instantSpeed * 0.35);
          tracker.lastBytes = task.downloadedBytes;
          tracker.lastTick = now;
        }
      }
      activeUpdates.push(this._sanitizeTaskForUI(task));
    }

    if (activeUpdates.length > 0) {
      this.emit('telemetry:tick', activeUpdates);
    }
  }

  _sanitizeTaskForUI(task) {
    const total = task.totalBytes || 1;
    return {
      id: task.id,
      url: task.url,
      filename: task.filename,
      finalPath: task.finalPath,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      progress: task.totalBytes > 0 ? Math.min(100, (task.downloadedBytes / task.totalBytes) * 100) : 0,
      speedBps: task.speedBps,
      status: task.status,
      error: task.error,
      connections: task.connections,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      meta: task.meta,
      segments: task.segments.map((s) => {
        const segTotal = s.endByte >= s.startByte ? s.endByte - s.startByte + 1 : 0;
        const segDone = Math.max(0, s.currentOffset - s.startByte);
        return {
          id: s.id,
          status: s.status,
          stolen: Boolean(s.stolen),
          startRatio: s.startByte / total,
          widthRatio: segTotal > 0 ? segTotal / total : 1,
          fillRatio: segTotal > 0 ? Math.min(1, segDone / segTotal) : 0,
        };
      }),
    };
  }

  _extractFilenameFromUrl(urlStr) {
    try {
      const parsed = new URL(urlStr);
      let base = path.basename(parsed.pathname);
      if (base && base.includes('.')) {
        try {
          base = decodeURIComponent(base);
        } catch {}
        const sanitized = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        if (sanitized) return sanitized;
      }
      return `bravedm_${Date.now()}.bin`;
    } catch {
      return `bravedm_${Date.now()}.bin`;
    }
  }

  async _resolveUniqueFilePath(targetPath) {
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);
    const dir = path.dirname(targetPath);
    let candidate = targetPath;
    let counter = 1;

    const existingFinalPaths = new Set(
      Array.from(this.tasks.values())
        .map((t) => t.finalPath)
        .filter(Boolean)
    );

    while (true) {
      if (existingFinalPaths.has(candidate)) {
        candidate = path.join(dir, `${base}(${counter++})${ext}`);
        continue;
      }

      let existsOnDisk = false;
      try {
        await fsp.access(candidate);
        existsOnDisk = true;
      } catch {}

      let partExistsOnDisk = false;
      try {
        await fsp.access(`${candidate}.bravedm.part`);
        partExistsOnDisk = true;
      } catch {}

      if (existsOnDisk || partExistsOnDisk) {
        candidate = path.join(dir, `${base}(${counter++})${ext}`);
      } else {
        return candidate;
      }
    }
  }
}

module.exports = { DownloadManager };
