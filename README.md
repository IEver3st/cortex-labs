<div align="center">

# Cortex Studio

### A real-time 3D livery development environment for GTA V and FiveM

Preview `.yft` vehicles, `.ydd` clothing models and layered textures without repeatedly launching the game. Cortex Studio keeps the design loop local, visual and immediate.

[![Latest Release](https://img.shields.io/github/v/release/IEver3st/cortex-labs?display_name=tag&sort=semver)](../../releases/latest)
[![Downloads](https://img.shields.io/github/downloads/IEver3st/cortex-labs/total)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows)](../../releases/latest)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://tauri.app/)
[![Licence](https://img.shields.io/github/license/IEver3st/cortex-labs)](./LICENSE)

[Download](../../releases/latest) · [Report a bug](../../issues/new) · [View releases](../../releases)

</div>

<!--
Add a current screenshot or short GIF here.
Recommended path: docs/media/cortex-studio-overview.png
-->

## Overview

Cortex Studio is a native desktop workspace for creating and reviewing GTA V and FiveM liveries.

It bridges the gap between design software and the game engine by loading vehicle or clothing assets directly, applying textures in real time and watching source files for changes. Save a texture in Photoshop, paint.net or another editor and the preview updates without a manual export-and-reload cycle.

The application is built for livery creators who need rapid iteration, reliable model support and a workspace that remembers where they left off.

## Why Cortex Studio

Traditional livery testing is slow:

1. Export the texture.
2. Move files into a resource.
3. Start or restart the game.
4. Spawn the vehicle.
5. Find the problem.
6. Repeat.

Cortex Studio reduces that loop to:

1. Open the model.
2. Open the texture.
3. Edit and save.
4. Review the result immediately.

No account is required, and project data remains on the local machine.

## Highlights

### Native GTA V asset support

- Load `.yft` vehicle fragments directly
- Load `.ydd` clothing and EUP assets
- Parse skeleton and bone data for models that depend on transforms
- Cache parsed geometry in the compact `.clmesh` format
- Preserve multiple UV channels for complex models

### Real-time texture workflow

- Watch texture files for changes and refresh the preview automatically
- Apply textures to livery materials, all meshes or specialised EUP targets
- Restore model paths, texture paths, camera position and project state
- Pin frequently used projects for quicker access
- Compare two models side by side in the multi-model viewer

### Broad texture support

| Category | Formats |
|---|---|
| Layered source files | PSD, PDN, AI |
| Standard images | PNG, JPG, BMP, WebP, TIFF, AVIF |
| Game and technical textures | DDS, TGA |

Cortex Studio includes a purpose-built DDS decoder with support for DXT1, DXT3, DXT5, BC4, BC5, BC7 and uncompressed texture formats.

### PSD Variant Builder

Create multiple livery variants from a single layered Photoshop file.

- Preserve layer and group hierarchy
- Toggle individual layers or entire groups
- Create, duplicate and rename variants
- Store a different visibility state for each variant
- Preview compositing changes directly on the 3D model
- Batch export variants as high-resolution PNG files

### Template Generator

Generate a starting livery template directly from a model.

- Inspect model geometry and UV data
- Select or refine template regions manually
- Display a cage wireframe overlay
- Export layered PSD or PNG output
- Preview the generated template before export

> [!NOTE]
> The Template Generator is a beta workflow. Complex or unusually authored assets may still require manual correction.

### Preview and presentation tools

- Independent primary, secondary, accent and glass material colours
- Interactive hemisphere lighting control
- Adjustable glossiness, lighting and background
- Front, rear, side, three-quarter and top camera presets
- Multi-angle batch captures
- Configurable text watermarks
- Model shadows
- Optional WASD camera movement
- Light and dark interface themes
- Adjustable UI scaling

## Supported files

### Models

```text
.yft    GTA V and FiveM vehicle fragments
.ydd    GTA V drawable dictionaries and EUP clothing assets
```

### Textures

```text
.psd  .png  .jpg  .tga  .dds  .bmp
.webp .tiff .avif .pdn  .ai
```

## Installation

1. Open the [latest release](../../releases/latest).
2. Download the Windows installer.
3. Run the installer.
4. Launch Cortex Studio.
5. Create a project and select a supported model.
6. Select the texture or layered source file you want to preview.

The packaged application includes the model-processing bridge required for normal use.

## Typical workflow

1. Create a new livery project.
2. Select a `.yft` vehicle or `.ydd` clothing model.
3. Select the texture you are editing.
4. Choose the most appropriate viewing mode.
5. Set representative vehicle colours and lighting.
6. Edit the source file in your preferred design application.
7. Save the file and inspect the refreshed preview.
8. Capture presentation images or export PSD variants when finished.

## Viewing modes

| Mode | Purpose |
|---|---|
| Livery | Targets vehicle paint and livery materials |
| All Textures | Applies the selected texture across the model for inspection |
| EUP | Handles clothing and Emergency Uniform Pack workflows |
| Multi-Model | Compares two models with independent texture controls |
| Template | Provides template-generation tools and wireframe inspection |

## Architecture

Cortex Studio combines several runtimes where each is most useful:

```text
React interface
      │
      ├── Three.js real-time renderer
      ├── PSD, PDN and image processing
      ├── Custom DDS and BC7 decoding
      │
      ▼
Tauri command layer
      │
      ├── Native file access
      ├── File watching
      ├── Project persistence
      └── Application updates
      │
      ▼
Rust desktop backend
      │
      ▼
C# CodeWalker bridge
      │
      ▼
.clmesh binary cache
```

The C# bridge parses GTA V assets through CodeWalker.Core and emits `.clmesh` data for the application. The JavaScript renderer then handles interactive material, texture and camera work.

## Technology

| Layer | Technology |
|---|---|
| Desktop runtime | Tauri 2 |
| Native backend | Rust |
| Asset bridge | C# and CodeWalker.Core |
| Frontend | React 19 |
| 3D rendering | Three.js |
| Styling | Tailwind CSS 4 |
| Build tooling | Vite 7 and Bun |
| PSD processing | ag-psd |
| Compression | pako |
| Native integrations | Tauri file system, dialog, process and updater plugins |

## Development

### Prerequisites

- Bun
- Rust stable toolchain
- Tauri system prerequisites
- .NET 10 SDK, only when rebuilding the CodeWalker bridge

### Install dependencies

```powershell
git clone https://github.com/IEver3st/cortex-labs.git
cd cortex-labs
bun install
```

### Run the full desktop application

```powershell
bun run tauri dev
```

### Run the frontend only

```powershell
bun run dev
```

Native file access, file watching and asset processing are limited when running only the frontend.

### Build

```powershell
bun run tauri build
```

### Tests

```powershell
bun run test:clmesh
bun run test:pdn
```

## Project structure

```text
cortex-labs/
├── src/
│   ├── components/                 # Application workspaces and interface
│   └── lib/
│       ├── yft.js                  # Model parsing and asset logic
│       ├── clmesh.js               # Binary mesh cache parser
│       ├── dds.js                  # DDS format parser
│       ├── bc7.js                  # BC7 decoder
│       ├── pdn.js                  # Paint.NET decoding
│       ├── camera-framing.js       # Automatic model framing
│       ├── camera-state.js         # Camera persistence
│       └── watermark.js            # Capture watermark rendering
├── src-tauri/                      # Rust desktop backend
├── tools/codewalker-bridge/        # C# model-processing sidecar
├── docs/                           # Technical and user documentation
└── third_party/                    # Third-party components and notices
```

## Limitations

Cortex Studio is deliberately focused on preview and iteration.

- It is not a full material or shader editor
- Final appearance can differ from the game because the renderer is not GTA V
- Preview fidelity depends on the source model, material names and UV layout
- Template generation may require correction for unusual assets
- Official builds are currently focused on Windows

Use the application to shorten the design loop, then perform a final in-game check before release.

## Privacy

Cortex Studio is local-first.

- No Cortex account is required
- Models and textures are processed on the machine
- Projects are stored locally
- No cloud service is required for normal operation

Bug reports are submitted only when the user explicitly chooses to send one.

## Contributing

Issues and pull requests are welcome.

Useful contributions include:

- Support for unusual model or texture cases
- Parser and decoder tests
- Performance improvements
- Documentation corrections
- Reproducible bug reports with non-copyrighted sample assets

Before submitting a large change, open an issue so the implementation can be discussed first.

## Licence

Cortex Studio is released under the [MIT Licence](./LICENSE).

Third-party components and their notices are documented in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Disclaimer

Cortex Studio is an independent community project. It is not affiliated with or endorsed by Rockstar Games, Take-Two Interactive, Cfx.re or Adobe.

---

<div align="center">

Built to spend less time reloading and more time designing.

</div>
