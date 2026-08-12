## Cortex Studio v4.1 — PRISM
![Cortex Studio UI](https://cdn.discordapp.com/attachments/1346902689744949270/1472021146311331871/image.png?ex=699af146&is=69999fc6&hm=6b2bf8b46a7498275f98db8eebed9bf07ec208901a893c1b59ddf2a89c0e56b0&)
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/C1C41TSVBX)

# Cortex Studio
### The Ultimate Livery Development Environment for GTA V / FiveM

Cortex Studio is a high-performance, real-time 3D livery previewer and development environment. It bridges the gap between your design software (Photoshop, paint.net, etc.) and the game engine, allowing for an instantaneous, iterative workflow.

Download the Latest Version [Here](https://github.com/IEver3st/cortex-labs/releases/latest)!

---

## New in v4.1 (PRISM)

> Named for the way this release refracts one focused Studio workflow across personal appearances, vehicle liveries, EUP clothing, and format-aware template output.

### Studio Appearance Presets
Choose from 12 full-workbench palettes with instant preview and independent System, Light, and Dark color schemes.

### Automatic EUP Template Generation
Generate clothing templates directly from `.ydd` models with EUP-aware UV and material behavior, vehicle-only layer filtering, and separate exports for multi-drawable dictionaries.

### Rebuilt Template Generator Workbench
Work from a compact inspector and dominant model canvas with Model, Template, and Split views, contextual marker tools, and theme-aware controls.

### In-App Feature Requests
Send structured feature requests from the feedback modal with focused prompts and request-specific GitHub labels.

### Clearer Studio Workflows
First-run setup, Settings, viewer controls, lighting, and mode-specific sidebars have been tightened around the edit-preview-export loop.

---

## New in v4.0 (ROAN)

> Named after the Roan Mountains / Roan Highlands on the Tennessee–North Carolina border.

### Vehicle Slot Colors (v4.0)
Per-slot color controls for primary, secondary, accent, and glass materials—paint each region of the vehicle independently instead of one flat body color. Available in Livery and All Textures modes.

### CLMESH Binary Cache (v4.0)
A new `.clmesh` binary mesh format replaces the old JSON pipeline between the CodeWalker bridge and the viewer. Smaller payloads, faster loads, and proper multi-UV channel support (UV2/UV3/UV4).

### Experimental Native Materials (v4.0)
Enable Experimental Settings, then open **All Textures → Native Materials** to resolve a YFT model's embedded, sibling, resource, and supported shared-game YTD textures automatically. The preview selects the highest available LOD, streams deduplicated DDS maps with progress reporting, and leaves manual texture selection as the final override.

### Skeleton Parsing (v4.0)
The YFT parser now reads skeleton/bone data, enabling correct skinning setup for models that rely on bone transforms.

### Interactive Light Dome (v4.0)
A drag-to-position hemisphere lighting widget that adjusts both azimuth (0–360°) and elevation (0–90°) simultaneously. Position the sun indicator on the dome to dial in the perfect lighting angle.

### Preview Watermarks (v4.0)
Automatically stamp preview captures with configurable text watermarks. Choose font family, size, color, opacity, position (corner/center/tiled), and rotation from Settings.

### Context Menus (v4.0)
Right-click context menus throughout the UI with custom Cortex Studio styling.

### Additional Texture Formats (v4.0)
TIFF and AVIF texture support added alongside existing PSD, PNG, JPG, TGA, DDS, BMP, WebP, PDN, and AI formats.

### Workspace Save-Fail Toast (v4.0)
When localStorage runs out of space, you now get a clear toast instead of a silent failure.

### PSD Variant Builder
The dedicated environment for managing complex livery projects with multiple variants.

- **PSD Native Workflow:** Load your Photoshop files directly. Cortex Studio parses layers and groups with full hierarchy support.
- **Variant Management:** Create, duplicate, and rename variants. Each variant stores its own unique set of layer visibilities.
- **IDE-Style Interface:** A professional layout featuring a variant sidebar, dual 3D/2D preview panes, and a comprehensive layer panel.
- **Solo & Group Controls:** Quickly isolate layers or toggle entire groups.
- **Batch Export:** Export all your variants at once to high-quality PNGs (up to 4K resolution) into a dedicated output folder.
- **Real-time Compositing:** As you toggle layers in the panel, the 3D model updates instantly with the new composited texture.

### Also improved in v4.0
- **Custom DDS/BC7 Texture Decoder:** Purpose-built DDS parser with DXT1/DXT3/DXT5, BC4, BC5, BC7, and uncompressed format support. Replaces reliance on Three.js DDSLoader and matches CodeWalker's TextureFormat enum exactly.
- **Multi-Angle Preview Capture:** Preview capture enhanced with selectable camera angles (Front, Back, Side, 3/4, Top), adjustable zoom factor, and progress indicator.
- **Camera Framing & State Persistence:** Improved auto-framing with better bounds computation and persistent camera state across model swaps and preset switches.
- **PDN Decoding:** Paint.NET files now decode via dedicated Web Worker with Tauri native fallback for improved reliability.

### Also shipped in recent releases
- **Model Shadows (v3.8):** Real-time shadow rendering for improved depth perception.
- **Template Generator (beta) (v3.7+):** Auto-create layered PSD templates directly from vehicle `.yft` and EUP `.ydd` models with live preview, manual marker selection (Alt/Ctrl/Shift + click), flexible `.psd`/`.png` exports, and cage wireframe overlay.

---

## Key Features

- **Vehicle Slot Colors:** Independent primary, secondary, accent, and glass color controls for accurate multi-region liveries.
- **CLMESH Mesh Cache:** Binary `.clmesh` format for fast model loads with multi-UV channel support.
- **Custom DDS/BC7 Decoder:** In-app DDS parsing with DXT1/3/5, BC4, BC5, BC7, and uncompressed format support.
- **Interactive Light Dome:** Drag-to-position hemisphere lighting for simultaneous azimuth/elevation control.
- **Multi-Angle Preview Capture:** Batch screenshot export from selectable camera angles with zoom and watermark support.
- **Preview Watermarks:** Configurable text watermarks with font, color, opacity, position, and rotation controls.
- **In-App Feedback:** Submit structured bug reports or feature requests with environment detection and optional console logs for bugs.
- **Template Generator (beta):** Auto-generate layered PSD templates directly from vehicle `.yft` and EUP `.ydd` models with live preview, per-format UV targeting, multi-drawable batch export, and manual marker selection.
- **PSD Variant Builder:** Manage complex livery projects with multiple variants, layer groups, and batch export to PNG.
- **Live Texture Reloading:** Uses a native file watcher to detect saves in your design software and reloads textures in milliseconds.
- **Five Powerful Viewing Modes:**
    - **Livery Mode:** Intelligently auto-targets vehicle carpaint and livery materials.
    - **All Textures:** Applies the loaded texture to every mesh on the model (great for checking templates).
    - **EUP Mode:** Specialized support for Emergency Uniform Packs and clothing models (`.ydd`).
    - **Multi-Model Viewer:** Compare two models side-by-side with independent texture controls.
    - **Template Mode:** Dedicated workspace for template generation with cage wireframe overlay.
- **Model Shadows:** Real-time shadow rendering for improved depth perception.
- **Camera Framing:** Auto-framing with persistent camera state across model swaps.
- **UI Scaling:** Adjustable interface scale for accessibility and high-DPI displays.
- **Context Menus:** Right-click context menus throughout the UI.
- **Workspace Persistence:** Recent projects restore their full state (model paths, textures, colors, camera positions) on relaunch.
- **Native GTA V Support:** Direct parsing of `.yft` (vehicles) and `.ydd` (clothing) files, with skeleton/bone data.
- **Full Camera Control:** Quick presets, center action, scoped six-axis WASD flight, right-mouse free-look, precision movement, and speed boost.
- **Material Controls:** Fine-tune body and slot colors, background color, glossiness, and light intensity to see how your design looks in different conditions.
- **Light & Dark Theme:** Branded light and dark modes with native system integration.
- **Fully Local & Private:** No cloud dependencies, no accounts, no data leaves your machine.
- **Tauri v2 Core:** Built on the latest Tauri framework for maximum performance and a tiny footprint.

---

## Supported Files

### Models
- **.yft** (GTA V/FiveM Vehicles)
- **.ydd** (GTA V/FiveM Clothing/EUP)

### Textures
- **.psd** (Photoshop - Recommended for Variants)
- **.png, .jpg, .tga, .dds, .bmp, .webp, .tiff, .avif, .pdn, .ai**

---

## Why Cortex Studio

Livery work is iterative. In-game testing is slow and breaks your flow. Cortex Studio keeps your preview live so you can focus on design and iteration instead of constant exporting, loading, and reloading.

---

## Limitations (By Design)

* **Not a material editor.** Experimental Native Materials provides a best-effort CodeWalker/OpenIV-style preview, but it does not reproduce every GTA shader, render state, animation, or in-game lighting behavior.
* **Preview-focused.** It’s built to **view liveries/textures in real time** on a 3D model—fast iteration, quick inspection, and instant feedback.
* **Asset fidelity depends on the source files.** What you see is constrained by the model/material setup and naming conventions in the asset.

---

## Project Structure

- `src/` - React UI, Three.js viewer, and logic.
- `src/components/VariantsPage.jsx` - The PSD Variant Builder.
- `src/components/TemplateGenerationPage.jsx` - Template Generator workspace for auto-generating PSD templates.
- `src/components/BugReportModal.jsx` - In-app bug and feature-request modal with environment detection.
- `src/components/LightDome.jsx` - Interactive hemisphere lighting control.
- `src/components/ContextMenu.jsx` - Radix-based context menu wrapper with Cortex styling.
- `src/lib/yft.js` - High-performance YFT/YDD parser (with skeleton/bone support).
- `src/lib/clmesh.js` - Parser for the `.clmesh` binary mesh cache emitted by the CodeWalker bridge.
- `src/lib/dds.js` - Custom DDS parser with DXT/BC4/BC5/BC7 and uncompressed format support.
- `src/lib/bc7.js` - BC7 block decoder.
- `src/lib/camera-framing.js` - Camera bounds computation and auto-framing system.
- `src/lib/camera-state.js` - Camera state clone/sync for persistence across model swaps.
- `src/lib/watermark.js` - Preview watermark configuration and rendering.
- `src/lib/bug-report.js` - Feedback payload builder, GitHub formatter, and environment detection.
- `src/lib/pdn.js` - Paint.NET file decoder with Web Worker and Tauri fallback.
- `src-tauri/` - Rust-based Tauri v2 backend for file system access, file watching, and mesh cache management.
- `tools/codewalker-bridge/` - C# sidecar that parses `.yft` files via CodeWalker.Core and emits `.clmesh` caches.

---

## Getting Started

### Prerequisites
- **Bun** (Fastest JS runtime & package manager)
- **Rust toolchain** (Required for building the Tauri app)
- **.NET 10 SDK** (Optional — only needed to build the CodeWalker bridge from source; bundled builds ship the executable)

### Installation
```bash
bun install
```

### Development
To run the full application with native features (recommended):
```bash
bun run tauri dev
```

To run just the UI (limited features, no file system access):
```bash
bun run dev
```

### Building
```bash
bun run tauri build
```

---

## Workflow Tips

- **Vehicle Slot Colors:** In Livery or All Textures mode, use the per-slot color cards to set primary, secondary, accent, and glass colors independently. Copy hex values between slots with the copy button.
- **Light Dome:** Drag the sun indicator on the hemisphere widget to adjust both lighting direction and elevation simultaneously.
- **Multi-Angle Previews:** Click the capture button, select which angles to export, set a zoom level, and generate batch screenshots in one pass.
- **Preview Watermarks:** Configure automatic text watermarks in Settings → Watermark to stamp all preview captures.
- **Feedback:** Click the feedback icon in the toolbar to submit a bug report or feature request. Environment details are added automatically, and bug reports can optionally include recent console logs.
- **UI Scaling:** Adjust the interface scale in Settings if you need larger or smaller UI elements.
- **Template Generator:** Start a new project from the home screen to auto-generate PSD templates from `.yft` vehicles or `.ydd` EUP clothing. Multi-drawable YDD dictionaries export one template per drawable to avoid overlapping UV layouts.
- **Manual Marker Selection:** In Template Generator, use Alt/Ctrl/Shift + click to pick individual markers. Selections stay staged until you confirm.
- **The Variant Sidebar:** Use it to create "Night", "High-Vis", or "Stealth" versions of your liveries in one project file.
- **Double-Click Layers:** In the Variant Builder, double-click a layer in the panel to "Solo" it.
- **Alt + 1-4:** Use these hotkeys to quickly switch between viewing modes.
- **Custom Hotkeys:** Check the Settings menu to customize every action to your liking.
- **Pinned Projects:** Pin frequently used projects to your home screen for quick access.
- **Workspace Restoration:** Your project state (models, textures, camera position) auto-saves and restores when you reopen the app.
- **Bridge Auto-Build:** If you're running from source and the CodeWalker bridge is missing, just open a `.yft`—Cortex will build it automatically if `dotnet` is on your PATH.

---

## License
MIT. Free forever. Developed with ❤️ for the GTA V modding community.

---

## Contributing
Contributions are welcome! Whether it is a bug fix, a new feature, or improved documentation, feel free to open an issue or a PR.
