// src/renderer/renderer.js
(() => {
  const api = window.braveAPI || window.vortexAPI;
  const tasks = new Map();
  let currentFilter = 'all';
  let searchQuery = '';
  let probedMediaData = null;
  let selectedPreset = null;
  let isModalBusy = false;

  // DOM References
  const taskListEl = document.getElementById('task-list');
  const emptyStateEl = document.getElementById('empty-state');
  const globalSpeedEl = document.getElementById('global-speed');
  const activePipesEl = document.getElementById('active-pipes-count');
  const countAllEl = document.getElementById('count-all');
  const countActiveEl = document.getElementById('count-active');
  const countCompletedEl = document.getElementById('count-completed');

  // Modal DOM
  const modalEl = document.getElementById('add-modal');
  const urlInputEl = document.getElementById('modal-url-input');
  const sliderEl = document.getElementById('modal-connections-slider');
  const sliderReadoutEl = document.getElementById('connections-readout');
  const btnProbeEl = document.getElementById('btn-probe-media');
  const btnStartEl = document.getElementById('btn-start-download');
  const mediaCardEl = document.getElementById('media-preview-card');
  const presetGridEl = document.getElementById('media-preset-grid');
  const statusMsgEl = document.getElementById('modal-status-msg');

  // Clipboard Banner DOM
  const clipBannerEl = document.getElementById('clipboard-banner');
  const clipUrlEl = document.getElementById('clipboard-detected-url');
  const clipBadgeEl = document.getElementById('clipboard-type-badge');

  async function init() {
    try {
      const initialTasks = await api.getAllTasks();
      for (const t of initialTasks || []) {
        tasks.set(t.id, t);
      }
    } catch (err) {
      console.error('Failed to load initial tasks:', err);
    }

    renderTaskList();
    bindUIEvents();
    bindIPCListeners();
    loadVersions();
  }

  async function loadVersions() {
    const badge = document.getElementById('yt-dlp-version-badge');
    if (!badge) return;
    try {
      const v = await api.getVersions();
      if (v && v.ytDlp && v.ytDlp.localVersion) {
        badge.textContent = v.ytDlp.localVersion.startsWith('v') ? v.ytDlp.localVersion : `v${v.ytDlp.localVersion}`;
        badge.title = `yt-dlp: ${v.ytDlp.binaryPath}`;
      } else {
        badge.textContent = 'yt-dlp ready';
      }
    } catch (err) {
      badge.textContent = 'yt-dlp ready';
    }
  }

  function bindIPCListeners() {
    api.onEvent('bravedm:task-created', (task) => {
      tasks.set(task.id, task);
      renderTaskList();
    });

    api.onEvent('bravedm:task-updated', (task) => {
      tasks.set(task.id, task);
      updateOrCreateCard(task);
      updateSidebarCounts();
    });

    api.onEvent('bravedm:task-completed', (task) => {
      tasks.set(task.id, task);
      updateOrCreateCard(task);
      updateSidebarCounts();
    });

    api.onEvent('bravedm:task-error', (task) => {
      tasks.set(task.id, task);
      updateOrCreateCard(task);
      updateSidebarCounts();
    });

    api.onEvent('bravedm:task-deleted', (taskId) => {
      tasks.delete(taskId);
      const card = document.getElementById(`task-${taskId}`);
      if (card) card.remove();
      updateSidebarCounts();
      checkEmptyState();
    });

    // High-frequency 250ms telemetry tick updating speeds and 64-segment visualizers
    api.onEvent('bravedm:telemetry-tick', (activeUpdates) => {
      let totalBps = 0;
      let totalActivePipes = 0;

      for (const updated of activeUpdates) {
        tasks.set(updated.id, updated);
        totalBps += updated.speedBps || 0;
        totalActivePipes += (updated.segments || []).filter((s) => s.status === 'active').length;
        updateOrCreateCard(updated);
      }

      globalSpeedEl.textContent = `${formatBytes(totalBps)}/s`;
      activePipesEl.textContent = `${totalActivePipes} Active Pipes`;
      updateSidebarCounts();
    });

    // Clipboard Auto-Paste Detection
    api.onEvent('bravedm:clipboard-url-detected', ({ url, type }) => {
      clipUrlEl.textContent = url;
      clipBadgeEl.textContent = type === 'media' ? 'MEDIA STREAM' : 'DIRECT FILE';
      clipBannerEl.classList.remove('hidden');
    });

    // Media Mux Events (yt-dlp DASH video/audio merge)
    api.onEvent('bravedm:media-mux-started', (taskInfo) => {
      // Ensure task card exists
      if (!tasks.has(taskInfo.id)) {
        tasks.set(taskInfo.id, {
          id: taskInfo.id,
          filename: taskInfo.filename,
          totalBytes: 0,
          downloadedBytes: 0,
          progress: 0,
          speedBps: 0,
          status: 'downloading',
          segments: [],
          meta: { thumbnail: taskInfo.thumbnail, durationFormatted: taskInfo.durationFormatted },
          createdAt: Date.now(),
        });
        renderTaskList();
      }
    });

    api.onEvent('bravedm:media-mux-progress', (progress) => {
      const task = tasks.get(progress.id);
      if (task) {
        task.progress = progress.percent || task.progress;
        if (progress.speedStr) {
          task.customSpeedStr = progress.speedStr;
        }
        updateOrCreateCard(task);
      }
    });

    api.onEvent('bravedm:media-mux-completed', ({ id, finalPath }) => {
      const task = tasks.get(id);
      if (task) {
        task.status = 'completed';
        task.progress = 100;
        task.finalPath = finalPath;
        updateOrCreateCard(task);
        updateSidebarCounts();
      }
    });

    api.onEvent('bravedm:media-mux-error', ({ id, error }) => {
      const task = tasks.get(id);
      if (task) {
        task.status = 'error';
        task.error = error;
        updateOrCreateCard(task);
        updateSidebarCounts();
      }
    });
  }

  /**
   * Renders or updates a single task card in-place and paints its HiDPI segment canvas.
   */
  function updateOrCreateCard(task) {
    if (!matchesFilter(task)) {
      const existing = document.getElementById(`task-${task.id}`);
      if (existing) existing.remove();
      checkEmptyState();
      return;
    }

    let card = document.getElementById(`task-${task.id}`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'task-card';
      card.id = `task-${task.id}`;
      card.innerHTML = `
        <div class="task-header">
          <div class="file-icon">${getFileTypeIconSVG(task.filename)}</div>
          <div class="task-title-group">
            <div class="task-filename" title="${escapeHtml(task.filename)}">${escapeHtml(task.filename)}</div>
            <div class="task-submeta">
              <span class="meta-size"></span>
              <span class="meta-speed"></span>
              <span class="meta-chunks"></span>
            </div>
          </div>
          <div class="task-controls">
            <button class="btn btn-xs btn-ghost btn-toggle-state">Pause</button>
            <button class="btn btn-xs btn-ghost btn-open-file hidden">Open</button>
            <button class="btn btn-xs btn-ghost btn-open-folder" title="Show in Folder">Folder</button>
            <button class="btn btn-xs btn-danger-ghost btn-delete-task" title="Delete Task">&times;</button>
          </div>
        </div>
        <div class="segment-visualizer-wrap">
          <canvas class="segment-canvas"></canvas>
        </div>
        <div class="task-footer">
          <span class="footer-status"></span>
          <span class="footer-progress"></span>
        </div>
      `;

      // Event Listeners for Card Controls
      const toggleBtn = card.querySelector('.btn-toggle-state');
      toggleBtn.addEventListener('click', () => {
        const current = tasks.get(task.id);
        if (!current) return;
        if (current.status === 'downloading') {
          api.pauseTask(current.id);
        } else if (current.status === 'paused' || current.status === 'error') {
          api.resumeTask(current.id);
        }
      });

      const openFileBtn = card.querySelector('.btn-open-file');
      openFileBtn.addEventListener('click', () => {
        const current = tasks.get(task.id);
        if (current && current.finalPath) {
          api.openFile(current.finalPath);
        }
      });

      const openFolderBtn = card.querySelector('.btn-open-folder');
      openFolderBtn.addEventListener('click', () => {
        const current = tasks.get(task.id);
        if (current) {
          const target = current.status === 'completed'
            ? current.finalPath
            : (current.partPath || current.finalPath || current.saveDir);
          api.showInFolder(target);
        }
      });

      const deleteBtn = card.querySelector('.btn-delete-task');
      deleteBtn.addEventListener('click', async () => {
        const current = tasks.get(task.id) || task;
        if (confirm(`Delete transfer "${current.filename}"?`)) {
          tasks.delete(task.id);
          card.remove();
          updateSidebarCounts();
          checkEmptyState();
          try {
            await api.deleteTask(task.id, false);
          } catch (err) {
            console.error('Failed to delete task:', err);
          }
        }
      });

      taskListEl.prepend(card);
    }

    // Always update filename and icon in case of redirects or Content-Disposition resolution
    const filenameEl = card.querySelector('.task-filename');
    if (filenameEl && filenameEl.textContent !== task.filename) {
      filenameEl.textContent = task.filename;
      filenameEl.title = task.filename;
      const iconEl = card.querySelector('.file-icon');
      if (iconEl) iconEl.innerHTML = getFileTypeIconSVG(task.filename);
    }

    // Update text telemetry
    const sizeText = task.totalBytes > 0
      ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`
      : formatBytes(task.downloadedBytes);
    card.querySelector('.meta-size').textContent = sizeText;

    let speedText = '--';
    if (task.status === 'downloading') {
      speedText = task.customSpeedStr ? task.customSpeedStr : `${formatBytes(task.speedBps || 0)}/s`;
    }
    card.querySelector('.meta-speed').textContent = speedText;

    const segments = task.segments || [];
    const activeCount = segments.filter((s) => s.status === 'active').length;
    const stolenCount = segments.filter((s) => s.stolen).length;
    card.querySelector('.meta-chunks').textContent = segments.length > 0
      ? `${activeCount}/${segments.length} Segments (${stolenCount} Split)`
      : 'Media Stream Mode';

    const toggleBtn = card.querySelector('.btn-toggle-state');
    const openFileBtn = card.querySelector('.btn-open-file');

    if (task.status === 'completed') {
      toggleBtn.classList.add('hidden');
      openFileBtn.classList.remove('hidden');
    } else if (task.status === 'probing') {
      toggleBtn.classList.remove('hidden');
      openFileBtn.classList.add('hidden');
      toggleBtn.disabled = true;
      toggleBtn.textContent = 'Probing...';
    } else {
      toggleBtn.classList.remove('hidden');
      openFileBtn.classList.add('hidden');
      toggleBtn.disabled = false;
      toggleBtn.textContent = task.status === 'downloading' ? 'Pause' : 'Resume';
    }

    const footerStatus = card.querySelector('.footer-status');
    footerStatus.textContent = task.error
      ? `Error: ${task.error}`
      : `Status: ${task.status.toUpperCase()}`;
    footerStatus.style.color = task.error ? 'var(--accent-red)' : (task.status === 'completed' ? 'var(--accent-green)' : 'var(--text-secondary)');

    card.querySelector('.footer-progress').textContent = `${(task.progress || 0).toFixed(1)}%`;

    // Paint the 32-64 Segment Visualizer Canvas
    const canvas = card.querySelector('.segment-canvas');
    drawSegmentVisualizer(canvas, task);

    checkEmptyState();
  }

  /**
   * HiDPI Canvas Renderer for Brave DM's Multi-Segment & Work-Stealing Bar.
   * Accurately maps each segment's byte range (`startRatio`, `widthRatio`) and `fillRatio`.
   */
  function drawSegmentVisualizer(canvas, task) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    // Base dark track
    ctx.fillStyle = '#0D1017';
    ctx.fillRect(0, 0, width, height);

    const segments = task.segments || [];

    // Fallback: If single media stream or no segment partition, render single smooth progress bar
    if (segments.length === 0) {
      const progressRatio = Math.min(1, Math.max(0, (task.progress || 0) / 100));
      const fillW = Math.floor(width * progressRatio);

      if (fillW > 0) {
        ctx.fillStyle = task.status === 'completed' ? '#10B981' : (task.status === 'paused' ? '#F59E0B' : '#00E5FF');
        ctx.fillRect(0, 0, fillW, height);

        if (task.status === 'downloading' && progressRatio < 1) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(Math.max(0, fillW - 2 * dpr), 0, 2 * dpr, height);
        }
      }
      return;
    }

    const gap = Math.max(1, Math.floor(1.5 * dpr));

    for (const seg of segments) {
      const segX = Math.floor(seg.startRatio * width);
      const segW = Math.max(2, Math.floor(seg.widthRatio * width) - gap);
      const fillW = Math.floor(segW * (seg.fillRatio || 0));

      // Unfilled background slot for this segment
      ctx.fillStyle = seg.stolen ? 'rgba(157, 78, 221, 0.14)' : 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(segX, 0, segW, height);

      if (fillW > 0) {
        if (task.status === 'completed' || seg.status === 'completed') {
          ctx.fillStyle = '#10B981'; // Emerald for completed byte range
        } else if (seg.status === 'active') {
          // Cyan for primary segments, Electric Purple for dynamically work-stolen splits
          ctx.fillStyle = seg.stolen ? '#9D4EDD' : '#00E5FF';
        } else if (task.status === 'paused') {
          ctx.fillStyle = '#F59E0B';
        } else {
          ctx.fillStyle = '#EF4444';
        }

        ctx.fillRect(segX, 0, fillW, height);

        // Glowing leading edge head on actively streaming segments
        if (seg.status === 'active' && seg.fillRatio < 1) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(Math.min(segX + fillW - 2 * dpr, segX + segW - 2 * dpr), 0, 2 * dpr, height);
        }
      }
    }
  }

  function renderTaskList() {
    // Preserve empty-state element, clear cards
    const cards = taskListEl.querySelectorAll('.task-card');
    cards.forEach((c) => c.remove());

    const sorted = Array.from(tasks.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const task of sorted) {
      updateOrCreateCard(task);
    }
    updateSidebarCounts();
    checkEmptyState();
  }

  function checkEmptyState() {
    const visibleCards = taskListEl.querySelectorAll('.task-card');
    if (visibleCards.length === 0) {
      emptyStateEl.classList.remove('hidden');
    } else {
      emptyStateEl.classList.add('hidden');
    }
  }

  function bindUIEvents() {
    // Filter navigation
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderTaskList();
      });
    });

    // Search box
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderTaskList();
    });

    // Open/Close Modal
    document.getElementById('btn-open-modal').addEventListener('click', () => openModal());
    document.getElementById('btn-close-modal').addEventListener('click', closeModal);
    document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);

    if (sliderEl && sliderReadoutEl) {
      sliderEl.addEventListener('input', () => {
        sliderReadoutEl.textContent = `${sliderEl.value} Segments`;
      });
    }

    // Clear All Completed Transfers
    const clearCompletedBtn = document.getElementById('btn-clear-completed');
    if (clearCompletedBtn) {
      clearCompletedBtn.addEventListener('click', async () => {
        try {
          const clearedIds = await api.clearCompletedTasks();
          for (const id of clearedIds || []) {
            tasks.delete(id);
            const card = document.getElementById(`task-${id}`);
            if (card) card.remove();
          }
          updateSidebarCounts();
          checkEmptyState();
        } catch (err) {
          console.error('Failed to clear completed tasks:', err);
        }
      });
    }

    // Check & Apply yt-dlp Updates
    const checkUpdatesBtn = document.getElementById('btn-check-updates');
    const updateStatusText = document.getElementById('updater-status-text');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', async () => {
        checkUpdatesBtn.disabled = true;
        checkUpdatesBtn.textContent = 'Checking...';
        if (updateStatusText) updateStatusText.textContent = 'Checking GitHub...';
        try {
          const res = await api.checkYtDlpUpdate();
          if (updateStatusText) {
            updateStatusText.textContent = res.message || 'Check complete.';
            updateStatusText.style.color = res.success ? 'var(--accent-green)' : 'var(--accent-red)';
          }
          await loadVersions();
        } catch (err) {
          if (updateStatusText) {
            updateStatusText.textContent = `Error: ${err.message}`;
            updateStatusText.style.color = 'var(--accent-red)';
          }
        } finally {
          setTimeout(() => {
            checkUpdatesBtn.disabled = false;
            checkUpdatesBtn.textContent = 'Check Updates';
          }, 2500);
        }
      });
    }

    // Clipboard Banner Actions
    document.getElementById('btn-clipboard-dismiss').addEventListener('click', () => {
      clipBannerEl.classList.add('hidden');
    });

    document.getElementById('btn-clipboard-grab').addEventListener('click', () => {
      const detectedUrl = clipUrlEl.textContent;
      clipBannerEl.classList.add('hidden');
      openModal(detectedUrl, clipBadgeEl.textContent === 'MEDIA STREAM');
    });

    // Probe Media with yt-dlp
    btnProbeEl.addEventListener('click', () => triggerMediaProbe());

    // Enter key handling on URL Input
    urlInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = urlInputEl.value.trim();
        if (isMediaUrl(val) && !probedMediaData) {
          triggerMediaProbe();
        } else {
          btnStartEl.click();
        }
      }
    });

    // Start Download (Protected by client lock + backend IPC mutex)
    btnStartEl.addEventListener('click', async () => {
      if (isModalBusy) return;
      const url = urlInputEl.value.trim();
      if (!url) return;

      // If user pasted a media URL directly without probing, auto-probe first
      if (!probedMediaData && isMediaUrl(url)) {
        await triggerMediaProbe();
        return;
      }

      setModalBusy(true, 'Initializing high-speed stream...');
      try {
        if (probedMediaData && selectedPreset) {
          await api.addMediaTask({
            webpageUrl: probedMediaData.webpageUrl,
            title: probedMediaData.title,
            thumbnail: probedMediaData.thumbnail,
            durationFormatted: probedMediaData.durationFormatted,
            preset: selectedPreset,
          });
        } else {
          await api.addHttpTask({
            url,
            connections: 64, // Always 64 parallel segments by default
          });
        }
        closeModal();
      } catch (err) {
        showModalStatus(err.message, true);
      } finally {
        setModalBusy(false);
      }
    });

    // Close modal on escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) {
        closeModal();
      }
    });
  }

  async function triggerMediaProbe() {
    if (isModalBusy) return;
    const url = urlInputEl.value.trim();
    if (!url) return;

    setModalBusy(true, 'Probing streams with yt-dlp...');
    mediaCardEl.classList.add('hidden');

    try {
      const info = await api.probeMedia(url);
      probedMediaData = info;
      selectedPreset = (info.presets && info.presets[0]) || null;

      const thumbEl = document.getElementById('media-thumb');
      if (info.thumbnail) {
        thumbEl.src = info.thumbnail;
        thumbEl.classList.remove('hidden');
      } else {
        thumbEl.classList.add('hidden');
      }

      document.getElementById('media-duration').textContent = info.durationFormatted || '00:00';
      document.getElementById('media-title').textContent = info.title;
      document.getElementById('media-uploader').textContent = info.uploader;

      presetGridEl.innerHTML = '';
      for (const preset of info.presets || []) {
        const option = document.createElement('div');
        option.className = `preset-option ${preset === selectedPreset ? 'selected' : ''}`;
        const sizeLabel = preset.estimatedBytes > 0 ? formatBytes(preset.estimatedBytes) : 'Stream';
        option.innerHTML = `
          <div>
            <div style="font-weight:600">${escapeHtml(preset.label)}</div>
            <div style="font-size:10px;color:var(--text-muted)">${preset.ext.toUpperCase()} • ${preset.requiresMuxing ? 'FFmpeg Mux' : 'Direct Turbo'}</div>
          </div>
          <span class="badge badge-cyan">${sizeLabel}</span>
        `;
        option.addEventListener('click', () => {
          document.querySelectorAll('.preset-option').forEach((el) => el.classList.remove('selected'));
          option.classList.add('selected');
          selectedPreset = preset;
        });
        presetGridEl.appendChild(option);
      }

      mediaCardEl.classList.remove('hidden');
      statusMsgEl.classList.add('hidden');
    } catch (err) {
      showModalStatus(`Probe error: ${err.message}`, true);
    } finally {
      setModalBusy(false);
    }
  }

  function openModal(prefillUrl = '', autoProbe = false) {
    probedMediaData = null;
    selectedPreset = null;
    urlInputEl.value = prefillUrl;
    mediaCardEl.classList.add('hidden');
    statusMsgEl.classList.add('hidden');
    modalEl.classList.remove('hidden');
    urlInputEl.focus();

    if (prefillUrl && autoProbe) {
      triggerMediaProbe();
    }
  }

  function closeModal() {
    modalEl.classList.add('hidden');
  }

  function setModalBusy(busy, statusText = '') {
    isModalBusy = busy;
    btnProbeEl.disabled = busy;
    btnStartEl.disabled = busy;
    if (statusText) showModalStatus(statusText, false);
  }

  function showModalStatus(msg, isError) {
    statusMsgEl.textContent = msg;
    statusMsgEl.style.color = isError ? 'var(--accent-red)' : 'var(--accent-cyan)';
    statusMsgEl.classList.remove('hidden');
  }

  function matchesFilter(task) {
    if (currentFilter === 'downloading' && task.status !== 'downloading') return false;
    if (currentFilter === 'completed' && task.status !== 'completed') return false;
    if (searchQuery && !(task.filename || '').toLowerCase().includes(searchQuery)) return false;
    return true;
  }

  function updateSidebarCounts() {
    const all = Array.from(tasks.values());
    countAllEl.textContent = all.length;
    countActiveEl.textContent = all.filter((t) => t.status === 'downloading').length;
    countCompletedEl.textContent = all.filter((t) => t.status === 'completed').length;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
  }

  function getFileTypeIconSVG(filename = '') {
    const ext = filename.split('.').pop().toLowerCase();
    if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) {
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'dmg', 'appimage', 'deb', 'rpm'].includes(ext)) {
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`;
    }
    if (['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg'].includes(ext)) {
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    }
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function isMediaUrl(text) {
    return /(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|twitter\.com|x\.com|tiktok\.com|dailymotion\.com|soundcloud\.com|facebook\.com|instagram\.com)/i.test(text || '');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
