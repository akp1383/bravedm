# Brave Download Manager (`bravedm`)

<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="BraveDM Logo" />
  <br>
  <strong>High-Performance Hybrid Segmented & Media Stream Download Manager</strong>
  <br>
  <em>Engineered for Linux, macOS, and Windows with Electron, Node.js Streams, yt-dlp, and FFmpeg</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-informational" alt="Platforms" />
  <img src="https://img.shields.io/badge/parallel%20streams-64-cyan.svg" alt="64 Streams" />
  <img src="https://img.shields.io/badge/tests-8%2F8%20passing-brightgreen.svg" alt="Tests" />
</p>

---

## ⚡ Overview & Core Features

Brave Download Manager combines the aggressive multi-segment acceleration and dynamic work-stealing of **Internet Download Manager (IDM)** with a modern cyber-dark UI and integrated media harvesting via `yt-dlp` and `ffmpeg`.

- **64-Segment Turbo HTTP Engine**:
  - Automatically slices HTTP Range requests into up to **64 concurrent connections**.
  - **Dynamic Work-Stealing**: When idle workers finish early, the engine dynamically halves the remaining range of slow active connections in-place without dropping underlying TCP connections.
  - Custom byte-boundary Transform streams enforce byte-exact boundaries and clean pipeline flushing.
- **Zero-Stitch Sparse File Allocation**:
  - Allocates physical files immediately on disk using `.bravedm.part` containers.
  - Segments stream straight into their target byte offsets—eliminating disk-heavy post-download chunk merging.
- **Deep Media Integration (`yt-dlp` & `ffmpeg`)**:
  - One-click probing of video links (YouTube, Vimeo, Twitch, TikTok, Twitter/X, and hundreds more).
  - Categorizes streams into **4K (2160p)**, **Full HD (1080p)**, **HD (720p)**, and **Audio-Only** presets with bitrate-based size estimation.
  - Multi-threaded DASH video/audio downloading via 64 concurrent fragments with automatic `ffmpeg` remuxing.
  - Full process lifecycle management with clean `AbortSignal` cancellation and native resume support.
- **Automated `yt-dlp` Updater**:
  - Checks the GitHub Releases API every 12 hours (and on-demand via the UI).
  - Performs atomic binary replacement into `~/.config/bravedm/bin/` so extractors never stay outdated.
- **60 FPS Zero-Reflow HiDPI Segment Visualizer**:
  - Real-time `<canvas>` visualizer rendering each segment's byte offset, dynamic width, fill ratio, and glowing leading-edge head.
  - Emerald (`#10B981`) for completed segments, Cyan (`#00E5FF`) for active primary streams, and Electric Purple (`#9D4EDD`) for work-stolen splits.
- **Crash-Resilient Atomic Persistence**:
  - Task states persist safely to `~/.config/bravedm/state.json` via atomic unique temporary files and file descriptor sync (`fsync`).
- **Clipboard Auto-Paste**:
  - Background monitor detects copied video streams or direct file links (`.zip`, `.iso`, `.tar`, `.mp4`, etc.) and prompts for instant one-click downloading.

---

## 📁 Repository Structure

```text
bravedm/
├── bin/                                # Bundled platform binaries (yt-dlp & ffmpeg)
│   ├── linux/x64/
│   └── mac/arm64/
├── build/                              # Packaging assets & hooks
│   ├── afterPack.js                    # POSIX chmod +x enforcement hook
│   ├── entitlements.mac.plist          # macOS Hardened Runtime allowances
│   ├── icon.svg                        # Vector source icon
│   └── icon.png                        # 512x512 High-resolution icon
├── scripts/
│   └── fetch-binaries.js               # Automated yt-dlp & ffmpeg provisioning script
├── src/
│   ├── main/
│   │   ├── index.js                    # Electron lifecycle & window management
│   │   ├── ipc/
│   │   │   └── ipcBridge.js            # Secure IPC routing & idempotency mutex locks
│   │   ├── engine/
│   │   │   ├── DownloadManager.js      # Core manager & dynamic work-stealing coordinator
│   │   │   └── SegmentWorker.js        # HTTP Range stream & boundary transform guard
│   │   ├── services/
│   │   │   ├── MediaProber.js          # yt-dlp JSON prober & stream executor
│   │   │   └── YtDlpUpdater.js         # Background & on-demand GitHub binary updater
│   │   └── utils/
│   │       ├── AtomicStore.js          # Crash-safe atomic JSON store
│   │       └── BinaryResolver.js       # Production, user-config, and system PATH resolver
│   ├── preload/
│   │   └── preload.js                  # Context-isolated API bridge
│   └── renderer/
│       ├── index.html                  # Dark-mode dashboard UI & modals
│       ├── styles/
│       │   └── theme-dark.css          # Glassmorphism dark theme CSS
│       └── renderer.js                 # Canvas segment visualizer & UI controller
├── test/
│   ├── engine.test.js                  # Engine, storage, collision, and prober tests
│   ├── download.test.js                # End-to-end multi-segment HTTP Range verification
│   └── workstealing.test.js            # In-flight dynamic chunk splitting verification
├── package.json
└── electron-builder.yml
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v20+ (recommended v22 or v26)
- **npm** v10+
- Optional system fallbacks: `yt-dlp` and `ffmpeg` in your system `PATH`.

### 2. Installation
```bash
git clone https://github.com/akp1383/bravedm.git
cd bravedm
npm install
```

### 3. Launch Development Mode
```bash
npm start
```

### 4. Run Automated Test Suite
```bash
npm test
```
Runs the 8 unit and integration tests verifying segment partitioning, work-stealing, boundary transform, atomic store, and SHA-256 binary assembly.

---

## 📦 Building Distribution Packages

### Linux (`x64`)
Builds AppImage, Arch Linux Pacman (`.pkg.tar.xz`), and Debian/Ubuntu (`.deb`) installers:
```bash
npm run dist:linux
```
Output files will be generated in `dist/`:
- `BraveDM-1.0.0-x86_64.AppImage`
- `bravedm-1.0.0-x64.pkg.tar.xz`
- `bravedm_1.0.0_amd64.deb`

### macOS Apple Silicon (`arm64`)
Builds DMG and ZIP with hardened runtime entitlements:
```bash
npm run dist:mac
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
