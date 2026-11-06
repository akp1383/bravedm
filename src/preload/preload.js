// src/preload/preload.js
const { contextBridge, ipcRenderer } = require('electron');

const apiDefinition = {
  getAllTasks: () => ipcRenderer.invoke('bravedm:get-all-tasks'),
  probeMedia: (url) => ipcRenderer.invoke('bravedm:probe-media', url),
  addHttpTask: (payload) => ipcRenderer.invoke('bravedm:add-http-task', payload),
  addMediaTask: (payload) => ipcRenderer.invoke('bravedm:add-media-task', payload),
  pauseTask: (taskId) => ipcRenderer.invoke('bravedm:pause-task', taskId),
  resumeTask: (taskId) => ipcRenderer.invoke('bravedm:resume-task', taskId),
  deleteTask: (taskId, deleteFiles = false) => ipcRenderer.invoke('bravedm:delete-task', { id: taskId, deleteFiles }),
  openFile: (filePath) => ipcRenderer.invoke('bravedm:open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('bravedm:show-in-folder', filePath),

  // Event Subscriptions for Real-Time Dark-Mode UI & Segment Visualizers
  onEvent: (channel, callback) => {
    const validChannels = [
      'vortex:task-created',
      'vortex:task-updated',
      'vortex:task-completed',
      'vortex:task-error',
      'vortex:task-deleted',
      'vortex:telemetry-tick',
      'vortex:clipboard-url-detected',
      'vortex:media-mux-started',
      'vortex:media-mux-progress',
      'vortex:media-mux-completed',
      'vortex:media-mux-error',
      'bravedm:task-created',
      'bravedm:task-updated',
      'bravedm:task-completed',
      'bravedm:task-error',
      'bravedm:task-deleted',
      'bravedm:telemetry-tick',
      'bravedm:clipboard-url-detected',
      'bravedm:media-mux-started',
      'bravedm:media-mux-progress',
      'bravedm:media-mux-completed',
      'bravedm:media-mux-error',
    ];

    if (validChannels.includes(channel)) {
      const subscription = (_event, data) => callback(data);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    }
  },
};

// Expose both namespaces for backwards and forward compatibility
contextBridge.exposeInMainWorld('vortexAPI', apiDefinition);
contextBridge.exposeInMainWorld('braveAPI', apiDefinition);
