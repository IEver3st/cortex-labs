## Cortex Studio v3.7.0

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/C1C41TSVBX)

# Cortex Studio
### The Ultimate Livery Development Environment for GTA V / FiveM

Cortex Studio is a high-performance, real-time 3D livery previewer and development environment. It bridges the gap between your design software (Photoshop, paint.net, etc.) and the game engine, allowing for an instantaneous, iterative workflow.

Download the Latest Version [Here](https://github.com/IEver3st/cortex-labs/releases/latest)!

---

## New in v3.7.0: Template Generator

The centerpiece of v3.7.0 is the **Template Generator (beta)**, a dedicated workspace for auto-generating layered `.psd` templates directly from `.yft` models.

- **Auto-generation from models:** Drop a `.yft` and Cortex Studio builds a fully-layered Photoshop template with UV shells mapped to spatial colors — no manual tracing.
- **Live preview:** See the template as it generates, with wireframe and world-space-normal diagnostic overlays for inspection.
- **Flexible export:** Save as `.psd`, `.png`, or both. Output folders are remembered, and you can open them directly from Cortex.
- **Background builds:** Template generation runs in a dedicated Web Worker, keeping the UI responsive on complex models.
- **Diagnostics & reporting:** Download a template map JSON, inspect diagnostic renders, and submit telemetry for failed generations.
- **Workspace persistence:** Your Template Generator session is saved and restored on relaunch.

---

## PSD Variant Builder

The **Variant Builder** is a dedicated environment for managing complex livery projects with multiple variants.

- **PSD Native Workflow:** Load your Photoshop files directly. Cortex Studio parses layers and groups with full hierarchy support.
- **Variant Management:** Create, duplicate, and rename variants. Each variant stores its own unique set of layer visibilities.
- **IDE-Style Interface:** A professional layout featuring a variant sidebar, dual 3D/2D preview panes, and a comprehensive layer panel.
- **Solo & Group Controls:** Quickly isolate layers or toggle entire groups.
- **Batch Export:** Export all your variants at once to high-quality PNGs (up to 4K resolution) into a dedicated output folder.
- **Real-time Compositing:** As you toggle layers in the panel, the 3D model updates instantly with the new composited texture.

---

## Key Features

- **Live Texture Reloading:** Uses a native file watcher to detect saves in your design software and reloads textures in milliseconds.
- **Four Powerful Viewing Modes:**
    - **Livery Mode:** Intelligently auto-targets vehicle carpaint and livery materials.
    - **All Textures:** Applies the loaded texture to every mesh on the model (great for checking templates).
    - **EUP Mode:** Specialized support for Emergency Uniform Packs and clothing models (`.ydd`).
    - **Multi-Model Viewer:** Compare two models side-by-side with independent texture controls.
- **Cage Wireframe Overlay:** Optional cage-style mesh overlay for detailed model inspection.
- **Native GTA V Support:** Direct parsing of `.yft` (vehicles) and `.ydd` (clothing) files.
- **Full Camera Control:** Quick presets (Front, Side, 3/4, Top), center action, and optional WASD flight controls.
- **Material Controls:** Fine-tune body color, background color, glossiness, and light intensity to see how your design looks in different conditions.
- **Light & Dark Mode:** Branded light-mode defaults and dark-mode overrides, with a native toggle in Settings.
- **Fully Local & Private:** No cloud dependencies, no accounts, no data leaves your machine.
- **Tauri v2 Core:** Built on the latest Tauri framework for maximum performance and a tiny footprint.

---

## Supported Files

### Models
- **.yft** (GTA V/FiveM Vehicles)
- **.ydd** (GTA V/FiveM Clothing/EUP)

### Textures
- **.psd** (Photoshop — recommended for Variants and Template Generator)
- **.png, .jpg, .tga, .dds, .bmp, .webp, .tiff**

---

## Why Cortex Studio

Livery work is iterative. In-game testing is slow and breaks your flow. Cortex Studio keeps your preview live so you can focus on design and iteration instead of constant exporting, loading, and reloading. The Template Generator takes it a step further — skip the blank-canvas problem entirely and start from a model-accurate template.

---

## Limitations (By Design)

* **Not a material editor.** Cortex Studio doesn't aim to replace a full material/shader workflow or in-game tuning.
* **Preview-focused.** It's built to **view liveries/textures in real time** on a 3D model — fast iteration, quick inspection, and instant feedback.
* **Asset fidelity depends on the source files.** What you see is constrained by the model/material setup and naming conventions in the asset.
* **Template Generator is in beta.** Generation quality depends on UV shell structure in the source model. Use the diagnostic tools and telemetry reporting if you hit issues.

---

## Project Structure

- `src/` - React UI, Three.js viewer, and logic.
- `src/components/VariantsPage.jsx` - The PSD Variant Builder.
- `src/components/TemplateGenerator/` - The Template Generator workspace.
- `src/lib/yft.js` - High-performance YFT/YDD parser.
- `src-tauri/` - Rust-based Tauri v2 backend for file system access and performance.

---

## Getting Started

### Prerequisites
- **Bun** (Fastest JS runtime & package manager)
- **Rust toolchain** (Required for building the Tauri app)

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

- **Template Generator:** Start here if you don't have a template yet. Drop your `.yft`, let Cortex build the layers, export as `.psd`, open in Photoshop.
- **The Variant Sidebar:** Use it to create "Night", "High-Vis", or "Stealth" versions of your liveries in one project file.
- **Double-Click Layers:** In the Variant Builder, double-click a layer in the panel to "Solo" it.
- **Alt + 1-4:** Use these hotkeys to quickly switch between viewing modes.
- **Custom Hotkeys:** Check the Settings menu to customize every action to your liking.
- **Recents & Pinned Projects:** Pin frequently-used projects from the home screen for faster access.

---

## License
MIT. Free forever. Developed with ❤️ for the GTA V modding community.
