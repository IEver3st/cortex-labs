# Changelog

All notable changes to Cortex Studio are documented here.

---

## [3.8.0] - 2026-03-31

### Added
- **Model shadows** - Added shadow rendering for improved depth perception on models
- **Missing set file warning** - Added warning when users don't have a set file configured for capturing previews
- **Template Generator manual marker selection** - Pick individual markers with Alt/Ctrl/Shift + click in "Marker Edit Mode"—selections stay staged until you confirm

### Changed
- **PDN support improved** - Enhanced Paint.NET file handling and compatibility
- **Template Generator marker behavior** - Only explicitly selected markers are painted in the generated PSD; removed "Regenerate Behavior" setting from marker interaction controls

### Fixed
- **UI fixes** - Various UI improvements and polish
- **Camera preset bug** - Fixed camera presets causing the world to tilt down when selecting 3/4 view and then moving the camera manually

---

## [3.7.0] - 2026-03-08

### Added
- **Template Generator (beta)** - Dedicated workspace for auto-generating layered `.psd` templates from `.yft` models with live preview, workspace persistence, and beta badging across the app
- **Flexible template exports** - Save generated templates as `.psd`, `.png`, or both, remember output folders, and open export folders directly from Cortex
- **Template diagnostics & reporting** - Template map JSON download, world-space-normal and wireframe diagnostics, and telemetry reporting for failed generations
- **Cage wireframe overlay** - Optional cage-style mesh overlay for model inspection in the viewer
- **Recents/workspace upgrades** - Pinned projects, search, sorting, richer recents grouping, and Template Generator as a first-class launch target

### Changed
- **Cortex Software palette alignment** - Reworked the desktop UI around the main website brand system with Paper Base, Stone, Card Off-White, Soft Black, Warm Clay, and Danger Red tokens plus updated typography
- **Light/dark brand theming** - Added branded light-mode defaults, dark-mode token overrides, and a native dark mode toggle in Settings
- **Shell and branding refresh** - Updated shell chrome, titlebar, release notes surfaces, select menus, and app icon/logo to match the new Cortex branding
- **Viewer control polish** - Reorganized viewer panels, refreshed light/material controls, and restored the Exterior Only workflow
- **Packaging & release metadata** - Updated app metadata for `3.7.0`, refreshed Tauri branding/package config, and restored linked release notes in the release workflow

### Performance
- **Background template builds** - Template generation can run in a dedicated Web Worker to keep the UI responsive during PSD builds
- **Template extraction pipeline** - Improved mesh extraction, UV shell mapping, spatial color generation, and preview generation for better throughput on complex models
- **Texture application path** - Smarter UV selection and wrapping reduce unnecessary remaps during livery application

### Fixed
- **Exterior Only visibility** - Better hiding behavior for interior, glass, wheels, and window-target edge cases
- **Model compatibility** - Hardened YFT parsing with better index-buffer detection and broader texcoord handling for problematic files
- **Texture targeting reliability** - Improved livery/material mapping heuristics, UV fallback behavior, and alpha handling
- **Context menu positioning** - Context menus stay anchored more reliably under scaling and resize changes
- **Updater & PDN safety** - Clearer updater failures plus stricter PDN decode limits to avoid bad-file crashes

---

## [3.5.0] - 2026-02-18

### Added
- **Dual-slot window textures** - Per-slot window design textures in multi-model mode for independent A/B window templates
- **YDD model support in multi-viewer** - Drag-and-drop `.ydd` files into the side-by-side comparison mode
- **Workspace state persistence** - Recent projects restore their full state (model paths, textures, colors, camera positions) on relaunch

### Changed
- **Performance: glossiness & body color** - Optimized material update path to avoid redundant scene traversals and texture reloads; slider interactions are now significantly smoother
- **UI refinements** - Replaced rounded corners with sharp brutalist aesthetic, compacted file labels, improved layout consistency

---

## [3.1.1] - 2026-02-10

### Added
- **Single-instance file-open & multi-model support** - Open `.yft`/`.ydd` files from Explorer; app focuses existing window instead of spawning a new instance; multi-model mode wired up accordingly

### Fixed
- Elegant window mode not appearing in window controls selector
- 3D Grid option not showing up in settings
- Variant Builder errors on startup
- Multi-model automatic livery updates not registering on either model slot

---

## [3.1.0] - 2026-02-08

### Added
- **PSD Variant Builder** - Dedicated environment for managing complex livery projects:
  - Native PSD layer/group parsing with full hierarchy
  - Variant management (create, duplicate, rename)
  - Real-time layer compositing with instant 3D preview
  - Batch export all variants to PNG (up to 4K)
- **Show/Hide Recents toggle** - Control whether recent sessions appear on the home screen
- **Workspace auto-save** - Session state saved and restored automatically

### Changed
- Renamed from "Cortex Labs" to "Cortex Studio"
- Major UI overhaul with Cyber aesthetic (dark backgrounds, cyan accents)

---

## [3.0.0] - 2026-02-06

### Added
- **Multi-model viewer** - Compare two models side-by-side with independent texture controls
- **Live texture reloading** - Native file watcher detects saves and reloads in milliseconds
- **Light intensity control** - Adjustable scene lighting
- **Glossiness control** - Fine-tune material roughness
- **EUP mode** - Specialized support for `.ydd` clothing/EUP models

### Changed
- Removed bundled YTD assets; simplified viewer architecture
- Improved YFT auto-detection and material targeting

---

## [2.3.3] - 2026-01

### Added
- Update checker with notification toast
- YTD texture browser with automatic mapping

### Fixed
- DDS row flipping for correct orientation

---

## [1.0.0] - 2025-12

### Added
- Initial release
- Direct `.yft` model parsing
- `.dff` model support
- Texture modes: Livery, All Textures
- Camera presets and orbit controls
- Body color and background color controls
- Hotkey system
- `.ai` texture support via PDF.js
- Onboarding flow
