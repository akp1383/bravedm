# Brave Download Manager (`bravedm`)

> High-Performance Hybrid Segmented & Media Stream Download Manager built with Electron and Node.js.

Brave Download Manager combines the multi-segment acceleration and dynamic work-stealing of Internet Download Manager (IDM) with the modern dark-mode aesthetic of Motrix/FDM and advanced media harvesting via `yt-dlp` and `ffmpeg`.

---

## ⚡ Key Architecture & Features

- **Dynamic Work-Stealing & In-Flight Chunk Halving**:
  - Automatically slices large HTTP Range requests into up to 64 concurrent connections.
  - When idle workers finish early, the engine dynamically halves the remaining range of slow active connections in-place without dropping TCP sockets.
  - Custom byte-boundary Transform streams ensure byte-exact truncation and clean pipeline flushing.
- **Deep Media Integration (`yt-dlp` & `ffmpeg`)**:
  - Built-in URL probing to detect video streams, thumbnails, and durations.
  - Automatically classifies streams into **4K (2160p)**, **Full HD (1080p)**, **HD (720p)**, and **Audio-Only** presets.
  - Direct HTTP streams are handed to the 32-chunk turbo engine; muxed streams are downloaded via 32 concurrent fragments and seamlessly muxed via `ffmpeg`.
- **Automatic yt-dlp Background Updater**:
  - Polls GitHub Releases every 12 hours for extractor updates and atomically replaces binaries in `~/.config/bravedm/bin/` so extractors never break.
- **60 FPS Zero-Reflow HiDPI Segment Visualizer**:
  - Native `<canvas>` visualizer rendering each segment's byte offset, dynamic width, fill ratio, and glowing leading-edge head.
  - Emerald (`#10B981`) for completed segments, Cyan (`#00E5FF`) for primary streams, and Electric Purple (`#9D4EDD`) for work-stolen splits.
- **Atomic State Persistence**:
  - Serializes task states to `~/.config/bravedm/state.json` debounced to 1,000ms and immediately upon task transitions.
  - Uses atomic unique temporary files and file descriptor sync (`fsync`) to prevent disk corruption on unexpected power loss.
- **Clipboard Auto-Paste**:
  - Automatically monitors clipboard for media (YouTube, Vimeo, Twitch, Twitter/X) or direct file URLs (.zip, .iso, .mp4, etc.) and prompts for instant one-click download.

---

## 📁 Project Directory Structure

```text
bravedm/
├── bin/                                # Bundled platform binaries
│   ├── linux/x64/                      # yt-dlp & ffmpeg for Linux
│   └── mac/arm64/                      # yt-dlp & ffmpeg for macOS
├── build/                              # Packaging assets & hooks
│   ├── afterPack.js                    # POSIX chmod +x enforcement
│   ├── entitlements.mac.plist          # macOS Hardened Runtime allowances
│   ├── icon.svg                        # Vector source icon
│   └── icon.png                        # 512x512 High-resolution app icon
├── scripts/
│   └── fetch-binaries.js               # Automated yt-dlp / ffmpeg provisioning
├── src/
│   ├── main/
│   │   ├── index.js                    # App lifecycle & window orchestration
│   │   ├── ipc/
│   │   │   └── ipcBridge.js            # Throttled IPC handlers & idempotency mutex locks
│   │   ├── engine/
│   │   │   ├── DownloadManager.js      # EventEmitter core & dynamic work-stealing
│   │   │   └── SegmentWorker.js        # HTTP Range stream & boundary transform guard
│   │   ├── services/
│   │   │   ├── MediaProber.js          # yt-dlp JSON metadata parser & stream extractor
│   │   │   └── YtDlpUpdater.js         # Background auto-updater for yt-dlp
│   │   └── utils/
│   │       ├── AtomicStore.js          # Crash-safe atomic JSON store
│   │       └── BinaryResolver.js       # Production vs development vs system binary locator
│   ├── preload/
│   │   └── preload.js                  # Isolated ContextBridge API (vortexAPI & braveAPI)
│   └── renderer/
│       ├── index.html                  # Dark-mode dashboard UI & modal
│       ├── styles/
│       │   └── theme-dark.css          # Motrix/FDM glassmorphism CSS
│       └── renderer.js                 # HiDPI canvas visualizer & UI controller
├── test/
│   ├── engine.test.js                  # Unit tests for engine, store, prober, resolver
│   ├── download.test.js                # End-to-end multi-segment HTTP Range verification
│   └── workstealing.test.js            # In-flight dynamic chunk splitting verification
├── package.json
└── electron-builder.yml
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd bravedm
npm install
```

### 2. Run in Development Mode
```bash
npm start
```

### 3. Run Test Suite
```bash
npm test
```
Runs the 7 comprehensive unit and end-to-end tests verifying atomic storage, segment slicing, work-stealing, and SHA-256 binary assembly.

---

## 📦 Building Distributables

### Linux (`x64`)
Builds AppImage, Arch Linux `.pacman` (`.pkg.tar.zst`), and Debian/Ubuntu `.deb`:
```bash
npm run dist:linux
```

### macOS Apple Silicon (`arm64`)
Builds DMG and ZIP with hardened runtime entitlements:
```bash
npm run dist:mac
```
