// src/main/index.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { DownloadManager } = require('./engine/DownloadManager');
const { MediaProber } = require('./services/MediaProber');
const { YtDlpUpdater } = require('./services/YtDlpUpdater');
const { BinaryResolver } = require('./utils/BinaryResolver');
const { IpcBridge } = require('./ipc/ipcBridge');

let mainWindow = null;
let downloadManager = null;
let ipcBridge = null;
let ytDlpUpdater = null;

async function bootstrap() {
  downloadManager = new DownloadManager({ maxConnections: 64 });
  await downloadManager.init();

  const ytDlpPath = BinaryResolver.getBinaryPath('yt-dlp');
  const ffmpegPath = BinaryResolver.getBinaryPath('ffmpeg');
  console.log(`[BraveDM] Resolved yt-dlp binary: ${ytDlpPath}`);
  console.log(`[BraveDM] Resolved ffmpeg binary: ${ffmpegPath}`);

  const mediaProber = new MediaProber({
    ytDlpPath,
    ffmpegPath,
  });

  const userBinDir = path.join(os.homedir(), '.config', 'bravedm', 'bin');
  ytDlpUpdater = new YtDlpUpdater({ binDir: userBinDir });
  ytDlpUpdater.start();

  const iconPath = path.join(__dirname, '../../build/icon.png');

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0B0D13',
    icon: iconPath,
    title: 'Brave Download Manager',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipcBridge = new IpcBridge(mainWindow, downloadManager, mediaProber, ytDlpUpdater);
  ipcBridge.register();

  mainWindow.removeMenu();

  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    if (ipcBridge) {
      ipcBridge.destroy();
      ipcBridge = null;
    }
    mainWindow = null;
  });
}

// Ensure single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});

app.on('before-quit', async (e) => {
  if (downloadManager && !downloadManager.isShuttingDown) {
    e.preventDefault();
    downloadManager.isShuttingDown = true;
    if (ytDlpUpdater) {
      ytDlpUpdater.stop();
    }
    // Pause all active transfers cleanly so byte offsets flush to state.json
    const activeIds = Array.from(downloadManager.tasks.keys());
    await Promise.all(activeIds.map((id) => downloadManager.pauseTask(id)));
    app.quit();
  }
});
