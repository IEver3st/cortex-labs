## Cortex Studio v3.1.1
![Cortex Studio UI](https://cdn.discordapp.com/attachments/698747360536297524/1471402183953223765/16.png?ex=698ecd91&is=698d7c11&hm=18ca93a4e4e63651f5fdcd35926ad410bc5e8f2107383a242ee4b87734773570&)
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/C1C41TSVBX)

# Cortex Studio
### The Ultimate Livery Development Environment for GTA V / FiveM

Cortex Studio is a high-performance, real-time 3D livery previewer and development environment. It bridges the gap between your design software (Photoshop, GIMP, etc.) and the game engine, allowing for an instantaneous, iterative workflow.

Download the Latest Version [Here](https://github.com/IEver3st/cortex-labs/releases/latest)!

---

## New: PSD Variant Builder
The centerpiece of v3.1 is the **Variant Builder**, a dedicated environment for managing complex livery projects with multiple variants.

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
- **Native GTA V Support:** Direct parsing of `.yft` (vehicles) and `.ydd` (clothing) files.
- **Full Camera Control:** Quick presets (Front, Side, 3/4, Top), center action, and optional WASD flight controls.
- **Material Controls:** Fine-tune body color, background color, glossiness, and light intensity to see how your design looks in different conditions.
- **Fully Local & Private:** No cloud dependencies, no accounts, no data leaves your machine.
- **Tauri v2 Core:** Built on the latest Tauri framework for maximum performance and a tiny footprint.

---

## Supported Files

### Models
- **.yft** (GTA V/FiveM Vehicles)
- **.ydd** (GTA V/FiveM Clothing/EUP)

### Textures
- **.psd** (Photoshop - Recommended for Variants)
- **.png, .jpg, .tga, .dds, .bmp, .webp, .tiff**

---

## Why Cortex Studio

Livery work is iterative. In-game testing is slow and breaks your flow. Cortex Studio keeps your preview live so you can focus on design and iteration instead of constant exporting, loading, and reloading.

---

## Limitations (By Design)

* **Not a material editor.** Cortex Studio doesn’t aim to replace a full material/shader workflow or in-game tuning.
* **Preview-focused.** It’s built to **view liveries/textures in real time** on a 3D model—fast iteration, quick inspection, and instant feedback.
* **Asset fidelity depends on the source files.** What you see is constrained by the model/material setup and naming conventions in the asset.

---

## Project Structure

- `src/` - React UI, Three.js viewer, and logic.
- `src/components/VariantsPage.jsx` - The new PSD Variant Builder.
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

- **The Variant Sidebar:** Use it to create "Night", "High-Vis", or "Stealth" versions of your liveries in one project file.
- **Double-Click Layers:** In the Variant Builder, double-click a layer in the panel to "Solo" it.
- **Alt + 1-4:** Use these hotkeys to quickly switch between viewing modes.
- **Custom Hotkeys:** Check the Settings menu to customize every action to your liking.

---

## ⚖ License
MIT. Free forever. Developed with ❤️ for the GTA V modding community.

---

## Contributing
Contributions are welcome! Whether it is a bug fix, a new feature, or improved documentation, feel free to open an issue or a PR.
