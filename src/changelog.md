# Cortex Studio 4.0 — Codename ROAN

> Named after the Roan Mountains / Roan Highlands on the Tennessee–North Carolina border. Ships per-slot vehicle color controls, a new binary `.clmesh` mesh cache, custom DDS/BC7 texture decoding, in-app bug reporting, an interactive Light Dome, preview watermarks, multi-angle preview capture, and more.

## New

- Vehicle Slot Colors | Per-slot primary, secondary, accent, and glass color controls—paint each region of the vehicle independently in Livery and All Textures modes.
- CLMESH Binary Cache | New `.clmesh` binary mesh format replaces the old JSON pipeline for smaller payloads, faster loads, and multi-UV channel support (UV2/UV3/UV4).
- Skeleton Parsing | YFT parser now reads skeleton/bone data for correct skinning setup on bone-transform models.
- Auto-Build CodeWalker Bridge | If the bundled bridge executable is missing, Cortex builds it from source on first `.yft` parse when `dotnet` is on PATH.
- In-App Bug Reporting | Submit bug reports from the toolbar with automatic environment detection and optional console log attachment.
- Interactive Light Dome | Drag-to-position hemisphere lighting control adjusting azimuth and elevation simultaneously from a single SVG widget.
- Preview Watermarks | Configurable text watermarks on preview captures with font, color, opacity, position, and rotation controls.
- UI Scaling | Adjustable interface scale from Settings for accessibility and high-DPI displays.
- Context Menus | Right-click context menus throughout the UI with custom styling and portal position guarding.
- TIFF Texture Support | Native TIFF decoding via UTIF for texture loading.
- AVIF Texture Support | AVIF added to supported texture formats.
- Console Log Buffer | Captures console output for optional inclusion in bug reports.
- Workspace Save-Fail Toast | Clear toast when localStorage runs out of space instead of a silent failure.

## Improved

- YFT Parsing Pipeline | Replaced JSON mesh output with `.clmesh` binary cache plus `manifest.json`; cache key bumped to `parse_yft_v5`.
- File-Open Handling | Full percent-decoding of `file://` URIs and resilient mutex access for pending open-file state.
- Bridge Discovery | Consolidated candidate search with publish output paths and on-demand source build fallback.
- PDN Decoding | Paint.NET files now decode via dedicated Web Worker with Tauri native fallback.
- Texture Loading | Custom DDS parser with DXT1/DXT3/DXT5, BC4, BC5, BC7, and uncompressed format support tried before Three.js DDSLoader fallback; signature-based format detection for DDS, PSD, PDN, and AI files.
- Multi-Angle Preview Capture | Preview capture enhanced with selectable camera angles (Front, Back, Side, 3/4, Top), adjustable zoom factor, and progress indicator.
- Camera Framing | Improved bounds-computation and auto-framing with persistent camera state across model swaps and preset switches.

## Fixed

- YTD Staging | Surface copy errors instead of silently ignoring failed YTD staging during conversion.
- Poisoned Mutex Recovery | Pending open-file state recovers from poisoned locks instead of panicking.
- Camera Preset Bugs | Fixed camera presets causing world tilt on 3/4 view followed by manual camera movement.
