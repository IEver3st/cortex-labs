# Changelog

All notable changes to Cortex Studio are documented here.

---

## [3.5.0] - 2026-02-18

### Added
- **Dual-slot window textures** — Per-slot window design textures in multi-model mode for independent A/B window templates
- **Single-instance file-open** — Open `.yft`/`.ydd` files directly from Explorer/Finder; app focuses existing window instead of spawning new instances
- **YDD model support in multi-viewer** — Drag-and-drop `.ydd` files into the side-by-side comparison mode
- **Workspace state persistence** — Recent projects restore their full state (model paths, textures, colors, camera positions) on relaunch

### Changed
- **Performance: glossiness & body color** — Optimized material update path to avoid redundant scene traversals and texture reloads; slider interactions are now significantly smoother
- **UI refinements** — Replaced rounded corners with sharp brutalist aesthetic, compacted file labels, improved layout consistency

---

## [3.1.1] - 2026-02-10

### Added
- **Variant export folder preference** — Set a default output folder for batch variant exports
- **Unload buttons** — Quickly clear selected model/texture with dedicated unload controls
- **Mode grid on home** — Redesigned launch area with clear mode selection cards

### Changed
- Improved select controls with better filename display and spacing
- Mac-style titlebar controls support

---

## [3.1.0] - 2026-02-08

### Added
- **PSD Variant Builder** — Dedicated environment for managing complex livery projects:
  - Native PSD layer/group parsing with full hierarchy
  - Variant management (create, duplicate, rename)
  - Real-time layer compositing with instant 3D preview
  - Batch export all variants to PNG (up to 4K)
- **Show/Hide Recents toggle** — Control whether recent sessions appear on the home screen
- **Workspace auto-save** — Session state saved and restored automatically

### Changed
- Renamed from "Cortex Labs" to "Cortex Studio"
- Major UI overhaul with Cyber aesthetic (dark backgrounds, cyan accents)

---

## [3.0.0] - 2026-02-06

### Added
- **Multi-model viewer** — Compare two models side-by-side with independent texture controls
- **Live texture reloading** — Native file watcher detects saves and reloads in milliseconds
- **Light intensity control** — Adjustable scene lighting
- **Glossiness control** — Fine-tune material roughness
- **EUP mode** — Specialized support for `.ydd` clothing/EUP models

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
