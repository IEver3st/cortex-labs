# Changelog

All notable changes to Cortex Studio are documented here.

---

## Unreleased

### Changed
- **Studio context menus** - Added a theme-aware right-click layer across the workspace with contextual editing commands, quick workspace actions, keyboard navigation, and guarded viewport positioning
- **Automatic toolbar updates** - Available releases now download immediately with visible toolbar progress, then become a single restart action that installs the staged update and reopens Cortex Studio
- **Compact update control** - Reduced the updater's toolbar footprint while preserving its progress, restart, retry, and keyboard-accessible states
- **Toolbar cleanup** - Removed the permanent Getting Started shortcut after initial setup while preserving the first-run onboarding flow
- **Template Generator workbench** - Rebuilt the empty and loaded experiences around a compact inspector, dominant model canvas, optional Model/Template/Split views, contextual marker actions, and theme-aware Studio controls
- **Model preview free camera** - WASD now follows the camera through full 3D space, right-mouse mouse-look rotates in place, Q/E adjusts elevation, and Alt/Shift provide precision and boosted movement without hijacking keys outside the focused preview
- **Release notes workspace** - Rebuilt What's New as a compact release ledger with category filters, always-readable change details, responsive desktop layouts, and clearer keyboard and clipboard feedback

### Fixed
- **Template preview framing** - Generated templates now open fitted to the available canvas with dedicated zoom-out, fit, and zoom-in controls for detailed UV inspection
- **Model viewport framing** - Model canvases now stay centered at high display scaling, with one-click default framing and 90-degree axis rotation controls in Template Generator
- **Interface scale adjustment** - Getting Started now previews slider values locally and applies the app-wide scale only after the interaction ends, keeping the control stable while dragging or using the keyboard
- **Preview export folder action** - The Preview Complete dialog now opens the saved image destination reliably and keeps folder-opening errors visible in the dialog
- **Theme-aware tooltips** - Replaced native browser hover labels with compact Studio tooltips that follow the active palette, keyboard focus, reduced-motion preferences, and viewport edges

---

## [4.1.0] - 2026-08-12 — PRISM

> Named for the way this release refracts one focused Studio workflow across personal appearances, vehicle liveries, EUP clothing, and format-aware template output.

### Added
- **In-app feature requests** - The feedback modal now submits structured feature requests alongside bug reports, with request-specific prompts and GitHub labels
- **Studio appearance presets** - Appearance settings now include 12 full-workbench palettes, instant unsaved preview, and independent System, Light, and Dark color schemes
- **Automatic EUP template generation** - Template Generator now accepts `.ydd` clothing models, uses EUP UV/material behavior, omits vehicle-only PSD layers, and exports separate templates for multi-drawable dictionaries

### Changed
- **Lighting controls** - Condensed the Environment lighting workspace into a compact direction instrument with inline angle refinement, segmented presets, and a single output row
- **Feedback modal flow** - Bug reports now start with a clearer report-type choice, use a compact fixed action footer, and blur the workspace heavily without a dialog shadow
- **First-run setup** - Replaced the multi-step Getting Started wizard with one focused destination choice, Home-first launch, and optional inline preference customization
- **Settings workspace** - Reorganized Settings into compact task groups, moved experimental access into About, and reduced repeated navigation and version details
- **Experimental settings** - Removed the Beta badge from the Experimental section header
- **Viewer control panels** - Removed the duplicated workflow summary and decorative step labels so each panel starts with its actionable tabs and controls
- **Format-aware template pipeline** - Template maps now preserve their real `yft`/`ydd` source type and select UV channels, preview targeting, and mesh scope according to the loaded model format
- **Mode-aware control panel** - Livery, All Textures, EUP, and Multi now use workflow-specific sidebar hierarchy, while Scene lighting adds direct drag positioning, keyboard adjustment, precision sliders, and quick lighting presets

### Fixed
- **Active tab seam** - Active tabs now stay visually fused to their workspace after opening and switching tabs
- **Theme-aware controls** - Buttons, toggles, focus states, and translucent workbench accents now follow the active Studio palette instead of retaining the Roan clay color

---

## [4.0.0] - 2026-07-02 — ROAN

> Named after the Roan Mountains / Roan Highlands on the Tennessee–North Carolina border.

### Added
- **Vehicle Slot Colors** - Per-slot color controls for primary, secondary, accent, and glass materials; paint each region of the vehicle independently instead of one flat body color. Available in Livery and All Textures modes
- **CLMESH binary cache** - New `.clmesh` binary mesh format replaces the old JSON pipeline between the CodeWalker bridge and the viewer; smaller payloads, faster loads, and proper multi-UV channel support (UV2/UV3/UV4)
- **Skeleton parsing** - YFT parser now reads skeleton/bone data, enabling correct skinning setup for models that rely on bone transforms
- **Interactive Light Dome** - Drag-to-position hemisphere lighting control that adjusts both azimuth (0–360°) and elevation (0–90°) simultaneously from a single interactive SVG widget
- **Preview watermarks** - Configurable text watermarks automatically stamped on preview captures; customize font family, font size, text color, opacity, position (corner/center/tiled), and rotation from Settings
- **Context menus** - Right-click context menus throughout the UI with custom Cortex Studio styling and portal position guarding
- **TIFF texture support** - Native TIFF decoding via UTIF for texture loading
- **AVIF texture support** - AVIF added to supported texture formats
- **Console log buffer** - Captures console output for optional inclusion in bug reports
- **Workspace save-fail toast** - When localStorage runs out of space, a clear toast is shown instead of a silent failure

### Changed
- **YFT parsing pipeline** - Replaced JSON mesh output with `.clmesh` binary cache plus `manifest.json`; cache key bumped to `parse_yft_v5`
- **File-open argument handling** - Full percent-decoding of `file://` URIs (not just `%20`) and resilient mutex access for pending open-file state
- **CodeWalker bridge discovery** - Consolidated candidate search with publish output paths and on-demand source build fallback
- **PDN decoding pipeline** - Paint.NET files now decode via dedicated Web Worker with Tauri native fallback for improved reliability and performance
- **Texture loading pipeline** - Custom DDS parser with DXT1/DXT3/DXT5, BC4 (ATI1), BC5 (ATI2), BC7, and uncompressed format support (A8R8G8B8/A8B8G8R8/X8R8G8B8/A1R5G5B5/A8/L8) tried before Three.js DDSLoader fallback; signature-based format detection for DDS, PSD, PDN, and AI files; matches CodeWalker's TextureFormat enum
- **Multi-angle preview capture** - Preview capture enhanced with selectable camera angles (Front, Back, Side, 3/4, Top), adjustable zoom factor, and progress indicator
- **Camera framing** - Improved bounds-computation and auto-framing with persistent camera state across model swaps and preset switches

### Fixed
- **YTD staging** - Surface copy errors instead of silently ignoring failed YTD staging during conversion
- **Poisoned mutex recovery** - Pending open-file state recovers from poisoned locks instead of panicking
- **Camera preset bugs** - Fixed camera presets causing world tilt on 3/4 view followed by manual camera movement

---

## [3.8.1] - 2026-04-06

### Fixed
- Fixed camera bugs

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
