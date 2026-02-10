## Updated Studio UI
![Cortex Studio UI](https://cdn.discordapp.com/attachments/698747360536297524/1469447401285746709/image.png?ex=6987b109&is=69865f89&hm=e7216855c670021fe97740c186e65dd54fe9145c71b998bf66ccd559f7c2f3dd&)
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/C1C41TSVBX)
# Tauri + React

Download the Latest Version [Here](https://github.com/IEver3st/cortex-labs/releases/tag/v3.0.0)!

## Model Support

- `.yft` (FiveM/GTA V): converted to RenderWare `.dff` via a bundled converter sidecar and parsed with `dff-loader`.
- `.obj` is intentionally unsupported: out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations. OBJ files will never be supported.

See:
- `THIRD_PARTY_NOTICES.md`

# Cortex Studio

Cortex Studio is a real-time livery previewer for GTA V / FiveM vehicle assets.
Its purpose is simple: let livery creators see texture changes to a 3D model instantly while they work.
It is free forever and fully open source under the MIT license.

Built with Tauri v2, React, Vite, and Three.js.

## Why Cortex Studio

Livery work is iterative. Exporting, loading, and reloading in-game is slow and breaks the flow.
Cortex Studio keeps your livery work live so you can focus on design instead of tooling.

## Key Features

- Live texture reloading on file save (Tauri file watcher)
- Load GTA/FiveM vehicle assets and preview materials in 3D
- Livery mode auto-targets carpaint/livery materials by name
- Quick camera presets and center action
- Drag-and-drop model loading
- Color controls for body and background
- Fully local, no cloud dependency

## Supported Files

Models:
- `.yft` (GTA V/FiveM Vehicles)
- `.ydd` (GTA V/Fivem Clothing)

Textures:
- `.png`, `.jpg`, `.jpeg`, `.tga`, `.dds`, `.bmp`, `.gif`, `.tiff`, `.webp`, `.psd`

## How It Works

1. Load a model using the file picker or drag-and-drop.
2. Select a texture file for your livery.
3. Cortex Studio watches the texture file and reloads it on every save.
4. Livery mode tries to auto-detect the correct material target using mesh/material names.
5. Adjust body/background colors and camera presets to inspect details quickly.

## Getting Started

### Prerequisites

- Bun (required for dependencies and scripts)
- Rust toolchain (for Tauri v2)
- Tauri CLI v2 (`bunx tauri` or `cargo install tauri-cli`)

### Install

```bash
bun install
```

### Run (full app)

```bash
bun run tauri dev
```

### UI-only (limited features)

```bash
bun run dev
```

Note: file dialogs and live file watching require the Tauri app.

### Build

```bash
bun run tauri build
```

## Workflow Tips

- Keep your livery texture open in your editor and save frequently.
- Use Livery mode when working with carpaint, sign, or decal materials.
- Use the camera presets (Front, Side, 3/4, Top) and Center for quick checks.
- If a material is not detected, switch to Everything mode or load a `.clmesh` cache.

## Project Structure (high level)

- `src/` React UI and viewer
- `src/components/Viewer.jsx` Three.js renderer and loaders
- `src/lib/yft.js` YFT parser
- `src-tauri/` Tauri v2 backend and file watchers
- `tools/` optional utilities for YFT workflows

## License

MIT. Free forever. Contributions are welcome.

## Contributing

Open an issue or submit a PR. If you change file formats or loaders, include a small sample asset and steps to reproduce.

