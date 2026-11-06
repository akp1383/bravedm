// src/main/ipc/ipcBridge.js
const { ipcMain, clipboard, app, shell } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');

function parseSizeStrToBytes(str) {
  if (!str || typeof str !== 'string') return 0;
  const match = str.trim().match(/^([0-9.]+)\s*([A-Za-z]+)?$/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  if (unit === 'KIB' || unit === 'KB') return Math.round(val * 1024);
  if (unit === 'MIB' || unit === 'MB') return Math.round(val * 1024 * 1024);
  if (unit === 'GIB' || unit === 'GB') return Math.round(val * 1024 * 1024 * 1024);
  if (unit === 'TIB' || unit === 'TB') return Math.round(val * 1024 * 1024 * 1024 * 1024);
  if (unit === 'B') return Math.round(val);
  return Math.round(val);
}

class IpcBridge {
  /**
   * @param {Electron.BrowserWindow} mainWindow
   * @param {import('../engine/DownloadManager').DownloadManager} downloadManager
   * @param {import('../services/MediaProber').MediaProber} mediaProber
   * @param {import('../services/YtDlpUpdater').YtDlpUpdater} [ytDlpUpdater]
   */
  constructor(mainWindow, downloadManager, mediaProber, ytDlpUpdater) {
    this.mainWindow = mainWindow;
    this.dm = downloadManager;
    this.prober = mediaProber;
    this.updater = ytDlpUpdater || null;

    /**
     * Mutex lock Set preventing multi-click race conditions on URL probing
     * and task creation. Keys auto-expire once the async action settles.
     */
    this.inFlightLocks = new Set();
    this.mediaControllers = new Map();
    this.lastClipboardText = '';
    this.clipboardInterval = null;
  }

  register() {
    this._bindEngineEvents();
    this._registerIpcHandlers();
    this._startClipboardMonitor();
  }

  destroy() {
    if (this.clipboardInterval) {
      clearInterval(this.clipboardInterval);
      this.clipboardInterval = null;
    }
    for (const controller of this.mediaControllers.values()) {
      try { controller.abort(); } catch {}
    }
    this.mediaControllers.clear();
  }

  /**
   * Helper to wrap IPC handlers in an idempotent mutex lock.
   */
  async _withIdempotencyLock(lockKey, asyncFn) {
    if (this.inFlightLocks.has(lockKey)) {
      throw new Error('Action already in progress for this resource. Ignoring duplicate trigger.');
    }
    this.inFlightLocks.add(lockKey);
    try {
      return await asyncFn();
    } finally {
      // Keep lock for a 350ms cooldown to absorb rapid UI double-clicks
      setTimeout(() => this.inFlightLocks.delete(lockKey), 350);
    }
  }

  _bindEngineEvents() {
    const sendToUI = (channel, payload) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, payload);
      }
    };

    this.dm.on('task:created', (task) => {
      sendToUI('vortex:task-created', task);
      sendToUI('bravedm:task-created', task);
    });

    this.dm.on('task:updated', (task) => {
      sendToUI('vortex:task-updated', task);
      sendToUI('bravedm:task-updated', task);
    });

    this.dm.on('task:completed', (task) => {
      sendToUI('vortex:task-completed', task);
      sendToUI('bravedm:task-completed', task);
    });

    this.dm.on('task:error', (task) => {
      sendToUI('vortex:task-error', task);
      sendToUI('bravedm:task-error', task);
    });

    this.dm.on('task:deleted', (taskId) => {
      sendToUI('vortex:task-deleted', taskId);
      sendToUI('bravedm:task-deleted', taskId);
    });

    this.dm.on('telemetry:tick', (updates) => {
      sendToUI('vortex:telemetry-tick', updates);
      sendToUI('bravedm:telemetry-tick', updates);
    });
  }

  _registerIpcHandlers() {
    const handleBoth = (vortexChannel, bravedmChannel, handler) => {
      ipcMain.handle(vortexChannel, handler);
      ipcMain.handle(bravedmChannel, handler);
    };

    // 1. Fetch initial task list for Dashboard hydration
    handleBoth('vortex:get-all-tasks', 'bravedm:get-all-tasks', () => {
      return Array.from(this.dm.tasks.values()).map((t) => this.dm._sanitizeTaskForUI(t));
    });

    // 2. Probe URL with yt-dlp (Protected against multi-click race conditions)
    handleBoth('vortex:probe-media', 'bravedm:probe-media', async (_event, rawUrl) => {
      const cleanUrl = (rawUrl || '').trim();
      if (!cleanUrl) throw new Error('URL cannot be empty.');

      const lockKey = `probe:${cleanUrl}`;
      return this._withIdempotencyLock(lockKey, async () => {
        return await this.prober.probeUrl(cleanUrl);
      });
    });

    // 3. Add Standard Turbo HTTP Download (Default 64 segments)
    handleBoth('vortex:add-http-task', 'bravedm:add-http-task', async (_event, payload) => {
      const { url, saveDir, filename, connections = 64, meta = {} } = payload;
      const targetDir = saveDir || app.getPath('downloads');
      const lockKey = `spawn:${url}:${filename || ''}`;

      return this._withIdempotencyLock(lockKey, async () => {
        const taskId = await this.dm.createTask({
          url,
          saveDir: targetDir,
          filename,
          connections: parseInt(connections, 10) || 64,
          meta,
        });
        return { taskId };
      });
    });

    // 4. Add Probed Media Download (Direct single-stream to Turbo Engine, or DASH to yt-dlp)
    handleBoth('vortex:add-media-task', 'bravedm:add-media-task', async (_event, payload) => {
      const { webpageUrl, title, thumbnail, durationFormatted, preset, saveDir } = payload;
      const targetDir = saveDir || app.getPath('downloads');
      const safeTitle = (title || 'media').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 140);
      const filename = `${safeTitle}[${preset.presetId.toUpperCase()}].${preset.ext}`;
      const lockKey = `media:${webpageUrl}:${preset.presetId}`;

      return this._withIdempotencyLock(lockKey, async () => {
        // If the stream does not require muxing and exposes a direct URL,
        // hand it directly to our parallel range engine
        if (!preset.requiresMuxing && preset.directUrl) {
          const taskId = await this.dm.createTask({
            url: preset.directUrl,
            saveDir: targetDir,
            filename,
            connections: 64,
            meta: {
              source: 'yt-dlp-direct',
              thumbnail,
              durationFormatted,
              lockedFilename: true,
              webpageUrl,
            },
          });
          return { taskId, mode: 'turbo-http' };
        }

        // Otherwise, register a managed media task and execute via yt-dlp concurrent fragments
        const taskId = crypto.randomUUID();
        const finalPath = await this.dm._resolveUniqueFilePath(path.join(targetDir, filename));
        const finalFilename = path.basename(finalPath);

        const taskRecord = this.dm.registerExternalTask({
          id: taskId,
          filename: finalFilename,
          saveDir: targetDir,
          totalBytes: preset.estimatedBytes || 0,
          meta: {
            source: 'yt-dlp-mux',
            thumbnail,
            durationFormatted,
            presetLabel: preset.label,
            formatSelector: preset.formatSelector,
            url: webpageUrl,
          },
        });

        this._startOrResumeMediaStream(taskRecord);
        return { taskId, mode: 'yt-dlp-mux' };
      });
    });

    // 5. Task Pause & Resume Controls (Supporting both Direct HTTP & yt-dlp Streams)
    handleBoth('vortex:pause-task', 'bravedm:pause-task', async (_e, taskId) => {
      const task = this.dm.tasks.get(taskId);
      if (task && task.meta && task.meta.source === 'yt-dlp-mux') {
        const controller = this.mediaControllers.get(taskId);
        if (controller) {
          controller.abort();
          this.mediaControllers.delete(taskId);
        }
        task.status = 'paused';
        task.speedBps = 0;
        await this.dm._persistStateImmediate();
        this.dm.emit('task:updated', this.dm._sanitizeTaskForUI(task));
        return;
      }
      return await this.dm.pauseTask(taskId);
    });

    handleBoth('vortex:resume-task', 'bravedm:resume-task', async (_e, taskId) => {
      const task = this.dm.tasks.get(taskId);
      if (task && task.meta && task.meta.source === 'yt-dlp-mux') {
        this._startOrResumeMediaStream(task);
        return;
      }
      return await this.dm.startTask(taskId);
    });

    // 6. Task Deletion & Clear Completed
    handleBoth('vortex:delete-task', 'bravedm:delete-task', async (_e, payload) => {
      const taskId = typeof payload === 'string' ? payload : payload.id;
      const deleteDiskFiles = typeof payload === 'object' ? Boolean(payload.deleteFiles) : false;
      const controller = this.mediaControllers.get(taskId);
      if (controller) {
        controller.abort();
        this.mediaControllers.delete(taskId);
      }
      return await this.dm.deleteTask(taskId, deleteDiskFiles);
    });

    handleBoth('vortex:clear-completed-tasks', 'bravedm:clear-completed-tasks', async () => {
      return await this.dm.clearCompletedTasks();
    });

    // 7. Open File / Show In Folder
    handleBoth('vortex:open-file', 'bravedm:open-file', async (_e, filePath) => {
      if (filePath) {
        return await shell.openPath(filePath);
      }
    });

    handleBoth('vortex:show-in-folder', 'bravedm:show-in-folder', (_e, filePath) => {
      if (filePath) {
        shell.showItemInFolder(filePath);
      }
    });

    // 8. Version Inspection & yt-dlp Updater Commands
    handleBoth('vortex:get-versions', 'bravedm:get-versions', async () => {
      const ytDlpStatus = this.updater ? await this.updater.getStatus() : { localVersion: 'N/A' };
      return {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        ytDlp: ytDlpStatus,
      };
    });

    handleBoth('vortex:check-yt-dlp-update', 'bravedm:check-yt-dlp-update', async () => {
      if (!this.updater) {
        return { success: false, message: 'Updater service is not initialized.' };
      }
      return await this.updater.checkForUpdates();
    });
  }

  /**
   * Spawns or resumes a managed yt-dlp media stream download with real-time UI telemetry
   * and clean AbortSignal cancellation.
   */
  _startOrResumeMediaStream(taskRecord) {
    const taskId = taskRecord.id;
    const existing = this.mediaControllers.get(taskId);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    this.mediaControllers.set(taskId, controller);

    taskRecord.status = 'downloading';
    taskRecord.error = null;
    this.dm.emit('task:updated', this.dm._sanitizeTaskForUI(taskRecord));

    const notifyUI = (channel, data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, data);
      }
    };

    notifyUI('vortex:media-mux-started', {
      id: taskId,
      filename: taskRecord.filename,
      thumbnail: taskRecord.meta && taskRecord.meta.thumbnail,
      durationFormatted: taskRecord.meta && taskRecord.meta.durationFormatted,
      presetLabel: taskRecord.meta && taskRecord.meta.presetLabel,
    });
    notifyUI('bravedm:media-mux-started', {
      id: taskId,
      filename: taskRecord.filename,
      thumbnail: taskRecord.meta && taskRecord.meta.thumbnail,
      durationFormatted: taskRecord.meta && taskRecord.meta.durationFormatted,
      presetLabel: taskRecord.meta && taskRecord.meta.presetLabel,
    });

    this.prober
      .downloadMediaStream({
        url: (taskRecord.meta && taskRecord.meta.url) || taskRecord.url,
        formatSelector: taskRecord.meta && taskRecord.meta.formatSelector,
        outputPath: taskRecord.finalPath,
        concurrentFragments: 64,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.totalSizeStr) {
            const parsedBytes = parseSizeStrToBytes(progress.totalSizeStr);
            if (parsedBytes > 0 && (!taskRecord.totalBytes || parsedBytes > taskRecord.totalBytes)) {
              taskRecord.totalBytes = parsedBytes;
            }
          }

          if (progress.percent != null) {
            taskRecord.downloadedBytes = taskRecord.totalBytes
              ? Math.round((progress.percent / 100) * taskRecord.totalBytes)
              : progress.percent;
          }

          notifyUI('vortex:media-mux-progress', { id: taskId, ...progress });
          notifyUI('bravedm:media-mux-progress', { id: taskId, ...progress });
          this.dm.emit('task:updated', this.dm._sanitizeTaskForUI(taskRecord));
        },
      })
      .then(async () => {
        this.mediaControllers.delete(taskId);
        taskRecord.status = 'completed';
        taskRecord.speedBps = 0;
        taskRecord.completedAt = Date.now();
        try {
          const stat = await fsp.stat(taskRecord.finalPath);
          taskRecord.totalBytes = stat.size;
          taskRecord.downloadedBytes = stat.size;
        } catch {}
        await this.dm._persistStateImmediate();

        notifyUI('vortex:media-mux-completed', { id: taskId, finalPath: taskRecord.finalPath });
        notifyUI('bravedm:media-mux-completed', { id: taskId, finalPath: taskRecord.finalPath });
        this.dm.emit('task:completed', this.dm._sanitizeTaskForUI(taskRecord));
      })
      .catch(async (err) => {
        this.mediaControllers.delete(taskId);
        if (controller.signal.aborted || taskRecord.status === 'paused') {
          taskRecord.status = 'paused';
          taskRecord.speedBps = 0;
          await this.dm._persistStateImmediate();
          this.dm.emit('task:updated', this.dm._sanitizeTaskForUI(taskRecord));
          return;
        }

        taskRecord.status = 'error';
        taskRecord.error = err.message;
        taskRecord.speedBps = 0;
        await this.dm._persistStateImmediate();

        notifyUI('vortex:media-mux-error', { id: taskId, error: err.message });
        notifyUI('bravedm:media-mux-error', { id: taskId, error: err.message });
        this.dm.emit('task:error', this.dm._sanitizeTaskForUI(taskRecord));
      });
  }

  /**
   * Monitors system clipboard for valid HTTP/HTTPS media or file links
   * and triggers auto-paste notifications in the Renderer UI.
   */
  _startClipboardMonitor() {
    this.clipboardInterval = setInterval(() => {
      try {
        const text = (clipboard.readText() || '').trim();
        if (!text || text === this.lastClipboardText) return;

        if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(text)) {
          this.lastClipboardText = text;
          const isMediaSite = /(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|twitter\.com|x\.com|tiktok\.com|dailymotion\.com|soundcloud\.com|facebook\.com|instagram\.com)/i.test(text);
          const isDirectFile = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|mp4|mkv|webm|avi|mov|mp3|m4a|flac|wav|exe|msi|dmg|pkg|appimage|deb|rpm|pdf)(\?.*)?$/i.test(text);

          if ((isMediaSite || isDirectFile) && this.mainWindow && !this.mainWindow.isDestroyed()) {
            const payload = {
              url: text,
              type: isMediaSite ? 'media' : 'direct',
            };
            this.mainWindow.webContents.send('vortex:clipboard-url-detected', payload);
            this.mainWindow.webContents.send('bravedm:clipboard-url-detected', payload);
          }
        }
      } catch {}
    }, 1500);
  }
}

module.exports = { IpcBridge };
