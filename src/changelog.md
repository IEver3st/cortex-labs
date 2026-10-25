version: 5.5.0
date: 2026-10-25
> Sirens now lays out like Siren Tool, with dual-colour heads and patterns you can build without a vehicle, and a new overlay shows a model's collision bounds.

## New
- Siren Tool layout | The Sirens sequencer is a column per light head with a lamp over each, beside a rail with the colours, play controls, Install and Save. Columns fit the window, and the preview column closes to give the grid the whole width.
- Dual-colour heads | Two sirens can share one column, so a head that flashes red and then blue is edited as one. In game the head needs a bone for each colour.
- Colours take turns | A new Pattern menu section flashes every siren of one colour together, then the next colour, steady or as a double, triple or quad flash.
- Patterns without a vehicle | New pattern builds a flash pattern with no vehicle open. Save it or copy the XML, and Use my pattern puts it on a vehicle later.
- Collisions | The hexagon button draws a model's collision bounds coloured by material, with a panel that counts triangles, shapes and materials.
- Mesh stats in more places | The triangle button shows triangles, vertices, meshes and size in Prop Studio and EUP Studio too.

## Fixed
- Saving over another setting | Save to file asks before replacing a setting with the same id in a carcols.meta it didn't come from.
- Resize flicker | Dragging a panel edge in EUP Studio, Prop Studio or Photo Mode no longer blanks the preview.

---

version: 5.4.0
date: 2026-10-21
> Build addon packs in EUP Studio's new Pack tab, set each item's sounds, game flags, hat hair and heel height, and build the creature metadata the game reads for hats and heels.

## New
- Pack tab | Building an addon pack now happens in EUP Studio's Pack tab, and Build an addon pack on the Model step opens it. Items are listed by slot with their new numbers: click one to wear it, move it to renumber the slot, or leave it out.
- Clothing properties | Set an item's sounds, prop transparency, game flags, hat hair flattening, hair squash and heel height, for one item or several at once. The ped shows how far a hat flattens its hair as you drag.
- Creature metadata | Built packs include creature metadata for hats that flatten hair and shoes with heels, made from the new pack's own items.

---

version: 5.3.5
date: 2026-10-19
> Write your own textures into EUP clothing, and build addon packs from folders of clothing, merging packs that share a model.

## New
- Clothing textures | EUP mode's new Textures tab lists a clothing item's textures a to z. Drop images on it to add textures or replace one; the write puts them in the item's .ytd files and counts new ones in its pack's .ymt, after a .bak.
- Build an addon pack | Build an addon pack on the Model step turns folders of freemode clothing into one new FiveM resource, numbered and ready to ensure. Merge identical models joins packs that recolour the same item. Escrowed resources are never copied.

---

version: 5.3.0
date: 2026-10-16
> Open a folder of vehicles to see a whole pack as snapshots and go through it car by car, and remove liveries a vehicle came with.

## New
- Folder of vehicles | Open a folder of vehicles on the Model step shows a pack's vehicles as snapshots on the new Pack view. Click one to work on it in Vehicle, and step through the rest with the arrows or Alt + PageUp and Alt + PageDown. Mod kit parts kept beside a car stay out of the list.
- Remove liveries | The bin on a livery already in the vehicle marks it for removal. The next write takes it out of every .ytd that holds it, after a .bak, together with your new liveries.

---

version: 5.2.0
date: 2026-10-16
> Vehicle mode brings Livery and All together, and its new Liveries tab writes a whole set of liveries into a vehicle at once.

## New
- Vehicle mode | One workspace for a vehicle replaces Livery and All: Paint, Liveries, Mods, Scene and Meta tabs, Kit shoot, saved builds and the model's own textures. Apply to keeps the livery on the paint or puts it on all meshes or one material or mesh. Your Livery and All projects and saved vehicles open in it, and Alt + 1 opens a new one.
- Write liveries in bulk | The Liveries tab lists the vehicle's liveries as the game numbers them. Add or drop your images, check the plan in Write N liveries…, and they go into the vehicle's own .ytd files after a .bak, at the size its liveries use. Restart the resource in game to load them.

## Improved
- Livery switcher in Liveries | The in-game livery switcher moved from Mods to the top of the Liveries tab.
- Clearer texture write errors | When a texture dictionary changed after Cortex read it, Write to textures… says the texture can no longer be replaced or added.
- Source code is public | Cortex Studio's source is published under the Cortex Studio Source-Available License 1.0: use it for anything, including commercial work, but don't redistribute, resell or rebrand it.

## Fixed
- Desktop security update | Tauri 2.12 fixes an origin check that could let a remote page call commands meant only for the app's own pages.

---

version: 5.1.1
date: 2026-10-15
> Write to textures now copies lens textures only from the vehicle's own resource.

## Improved
- Lens writes stay in the vehicle's resource | Write to textures… copies a lens texture only from a pack .ytd in the vehicle's own resource, never from the game's files or another resource. The dialog lists the sirens that use such a texture, and Texture colour leaves them as they are.

---

version: 5.1.0
date: 2026-10-15
> ELS vehicles preview and edit their lights in Sirens, Livery and All, and siren lens colours can be written into the vehicle's textures so they show in game.

## New
- ELS vehicles in Sirens | Switch step 2 to ELS to preview and edit a vehicle's VCF (ELS V8, ELS-FiveM, ELS-Plus or MISS-ELS): lights, stage patterns, misc, cruise and statics. Save changes only what you edited, after a .bak, or start a new VCF.
- ELS in Livery and All | The Meta tab's Lights section switches an ELS vehicle between carcols sirens and its VCF and runs its stages, cruise, takedowns and scene lights on the model.
- ELS live reload | The open VCF reloads when it changes on disk. Unsaved edits are never replaced; Load brings the new file in when you choose.
- What changed, before you save | With unsaved edits, the Status row of the siren setting and ELS steps lists what changed against the file.
- Write lens colours to textures | Write to textures… recolours the lit parts of the lens textures in the vehicle's own .ytd files, after a .bak, so the colours show in game. Sirens that share a lens part get one colour, picked right in the dialog.
- Lens glow preview | The Siren tab previews the selected sirens' lenses in the siren's colour or any colour.
- Open the _hi model | Opening a vehicle .yft that isn't the _hi model offers to open the _hi one beside it.

## Improved
- Tidier dock | Texture state, checks, status and ELS details are one aligned row each; lists open from their row.
- Model step actions | Replace and Unload sit on the file card, and Saved vehicle is a row under the model.
- Capture folds away | The Capture footer starts collapsed and remembers whether you opened it.
- File warnings match the studio | The standard model, unsupported image and PSD warnings use the studio's dialog style.
- Siren ids above 255 | The checks note that singleplayer needs SirenSetting Limit Adjuster for them.

## Fixed
- Presets restyle the selected sirens | A preset now restyles the selected sirens in place and keeps their aim, instead of adding sirens past the model's bones.
- Importing a resource's own siren setting | It opens that setting for editing, so Install to resource updates it instead of adding a copy.

---

version: 5.0.4
date: 2026-10-14
> Rear and side siren lights show on more vehicles, as they do in game, plus a solid wireframe view with mesh stats.

## New
- Solid wireframe with mesh stats | A button on the view deck draws every triangle edge over the shaded model and shows its triangles, vertices, meshes, shaders, textures and size. Works in Livery, All, EUP, Sirens and Multi.

## Fixed
- Rear and side siren lights | Vehicles that build their rear and side heads facing forward and aim them with the carcols delta now light the way they do in game, instead of staying dark inside the body.
- Indicators while sirens are paused | Hazards and indicators keep blinking after siren playback is paused or scrubbed.

---

version: 5.0.3
date: 2026-10-14
> Fixes EUP's Surface sliders, which did nothing on clothing, and gives EUP a showroom, upright clothing, the item's own textures and rotate buttons that stay on the bottom bar.

## New
- Showroom in EUP | EUP tabs have the Workbench / Showroom switch. The showroom stands the clothing under a spotlight in a dark studio, starting from the EUP scene in Settings > Studio.
- EUP textures load with the model | Picking a clothing model also loads the texture dictionary beside it (its _diff_ .ytd). A texture you choose yourself is never replaced; turn it off with Load EUP Textures in Settings > Viewer.
- Undo model turns | A reset button beside X, Y and Z stands the model back the way it loaded.

## Improved
- Rotate buttons stay on the bottom bar | X, Y and Z stay on the bottom bar when Panel Camera Controls moves the camera presets. A turn stands the model back on the floor and is saved with the workspace.

## Fixed
- EUP Surface sliders | Gloss, Roughness, Clearcoat and the Surface type now change clothing. The vehicle paint finish was applied over them, so none of them did anything. Light response also brightens past 1x.
- Upright clothing | EUP clothing stands upright and faces the Front shot instead of lying on its back.

---

version: 5.0.2
date: 2026-10-14
> Put any ped and props on set in EUP Studio, switch a vehicle's in-game liveries, save vehicles to Home, fit mod kits while you program sirens, and see lamps, lenses and glass the way they look in game.

## New
- Custom characters | EUP Studio's Character step puts any ped from your game files, or your own ped, on the stage, with its variations, props and animations.
- Props on set | The Scene tab stands up to 24 props around your characters; move them with the gizmo and they appear in every shot.
- Animation timeline | The Pose step has a frame scrubber, playback from 0.25x to 2x and a loop switch.
- In-game liveries | The Mods tab in All and Sirens has a Livery picker that steps through the vehicle's own liveries: the sign textures in its texture dictionary and the livery mods in its mod kit.
- Saved vehicles | Save vehicle under the model in Livery, All and Sirens keeps its mod kit parts, paint, extras, plate and livery. Open it again from Home while the model is on your PC; Locate finds a model that moved.
- Mod kits in Sirens | The Sirens inspector has a Mods tab, so you can fit lightbars, push bars and antennas while you program the lights.
- Undo everywhere it counts | Variant Builder and Template Generator markers undo and redo with Ctrl+Z and Ctrl+Shift+Z.
- Tabs come back | Project tabs open when you closed Cortex Studio reopen in the same order at the next start.

## Improved
- Siren callouts | Siren markers are numbered callouts in the siren's colour that stay on their lights while you orbit.
- Faster loads | Game textures finish about a third sooner, and the first mod kit part no longer waits on GTA V's shared textures.
- No clashing shortcuts | Settings warns when keys already belong to another action and offers to swap them; Alt + P saves the view you see.
- Extras and plates are saved | Extras you switch by hand and plate edits come back when you reopen the workspace or restart the app.

## Fixed
- Solid lamps | Tail light lenses and lamp housings draw in the model's material order and opacity, as in game, so you no longer see into the car through them.
- Lit lenses | Headlights, tail lights, running lights and in-lamp flashers fill their lens in the colour their texture gives them, and lamps hidden behind a mod kit blocker stay hidden.
- Safer files | Interrupted parses no longer leave broken caches, edited models and texture dictionaries show without a restart, and exports ask before replacing files.
- Paint.NET files | .pdn textures flatten with Paint.NET's own blend modes and hidden layers.

---

version: 5.0.1
date: 2026-10-10
> Mod kit parts open with the doors and boot they're fitted to, plates take your own artwork, and mod kit picks come back with the workspace.

## New
- Custom plate images | Import your own plate design (PNG, JPG, WebP or DDS) in the Plate section; the style's text is drawn over it, or clear the text for an image-only plate.

## Fixed
- Mod parts follow doors | Parts fitted to a door, the bonnet or the boot, such as door badges and boot antennas, move with it when it opens, and clicking one opens its door.
- Photo Mode mod parts | Parts fitted to bones other than the chassis no longer sit away from the body.
- Mod kits are saved | Parts picked in the Mods tab come back when you reopen the workspace or restart the app.

---

version: 5.0.0
date: 2026-10-09
> Studio 5 rebuilds every workspace in a new paper-and-ink look and adds Sirens, Photo Mode, Prop Studio and EUP Studio. Vehicles now open their doors, run their lights and wear their mod kits in the viewer.

## New
- Sirens | Edit a vehicle's carcols.meta siren setting on a 32-step sequencer while the pattern runs on the textured model (Alt + 9).
- Siren tools | Traffic advisor arrows and chases, six one-click lens colours, eight-way facings, presets, solo, mute and full undo.
- Install to resource | One click writes the setting into the resource's carcols.meta and links it in carvariations.meta, with a `.bak` of each file.
- Import siren settings | Read a setting from any carcols.meta into the editor and keep editing.
- ULC builder | Write the vehicle's `ulc.lua` entry with buttons, park, steady burn, brake, reverse and horn extras, with a live preview.
- Rename vehicle | Change a spawn name across the resource's meta files, scripts and `.yft`/`.ytd` files, with a preview and backups.
- Equipment | Every extra on the model with what it carries and a switch for each.
- Vehicle lights | Sirens, headlights, indicators, brakes and reverse light up the model, the ground and the body panels, with Glow, Spill, Fog and Night.
- Smart extras | Vehicles spawn with no extras on, then follow the resource's ULC config or their siren lights.
- Mod kits | Preview any part of the vehicle's carcols.meta mod kit in All, with saved builds.
- Part swap animation | Switching a mod part or an extra drops the old part away and bolts the new one on.
- Kit Shoot | Photograph a whole mod kit, part by part or build by build, with sheets, videos and a checked report.
- Doors and roofs | Open doors, bonnet and boot by clicking or Alt-dragging, and play convertible roof clips.
- Wheels, steering and plates | Textured wheels with their own paint slot, steering within the handling lock, and the game's 13 plate styles.
- Meta simulation | The Meta tab shows liveries, colour presets, extras and ids, with checks for common conflicts.
- Photo Mode | Stage up to 16 game vehicles, peds, props or your own models, light each one, and save PNGs up to 4K.
- Prop Studio | Inspect `.ydr`, `.ydd` and `.yft` props with their textures, glow and lights, and export transparent PNGs.
- EUP Studio | Dress two freemode peds with your clothing pack, pose them with game animations and held props, and export shots and videos.
- Import characters | Dress the ped as a saved vMenu character, a transfer code, or a Menyoo or Spooner outfit.
- Template overlays | Add a vehicle overlay layer and the Cortex Studio mark to generated templates.
- Studio defaults | Settings > Studio sets the stage, lights, floor, plate and wheel angle new work starts with.
- Ambient occlusion | Optional soft shading in creases and panel gaps, shown in captures.
- Showroom floors | Marble, Checker, Epoxy, Asphalt, Wood and Tread plate.
- Resizable panels | Drag any dock or inspector edge to resize it; each workspace remembers its widths.
- Select projects | Tick several projects on Home, or Select all that the filter shows, and delete them with one confirmation.
- Rotate in Multi | A rotate ring turns the selected vehicle in place, and each vehicle keeps its facing.

## Improved
- Studio 5 look | A new Cortex theme, condensed display type, keycaps, a new app icon and quieter tabs.
- Home | Workspaces grouped by job, and the selected project shown with its files in pipeline order.
- Workspaces | Livery, All, Multi, EUP, Variant Builder and Template Generator share one pipeline, viewfinder and inspector layout.
- Showroom | A dark studio stage with an aimable spotlight, reflections and contact shadows; captures use it.
- Paint | GTA's six paint slots with the game's palette and finishes, or any hex colour.
- Multi | A lineup of up to six vehicles, each with its own model, livery and paint.
- Variant Builder | Export reports what was written and stops before variants overwrite each other.
- Template markers | Draw marker boxes by hand; the preview zooms to 800% and pans freely.
- Menus | Right-click menus and dropdowns with readable rows and keycap shortcuts.
- First-run setup | Pick where to start and how Studio looks, applied as you choose.
- Settings | A new layout and options for project order, reduced motion, keycaps, updates and bug reports.
- Watermarks | Text, logo or both, with presets, finishes and any anchor, scaled to the capture.
- What's New and feedback | A searchable release timeline, and a feedback dialog that shows exactly what is sent.
- Game textures | A model's own GTA textures in All are no longer experimental.
- Performance | Opening a `.yft` no longer freezes the window, and idle tabs and the showroom do less work.

## Fixed
- Template PSDs | Generated PSDs no longer show solid black in apps that read the flattened image.
- Template auto-save | Edited PSDs are never overwritten, and partial saves say which files were written.
- Paint after saving settings | Saving a setting no longer resets the vehicle's paint.
- Game textures | Tyres and trim no longer turn blue or purple, and more texture formats load.
- Home projects | Projects reorder when you switch tabs and no longer drop off past the twelfth.
- File checks | Existing preview folders and workspace files are no longer reported missing.
- Drop errors | Livery says why a dropped file couldn't be loaded.
- Resource access | Metadata scans work for models on other drives.
- Capture | Framing and angle captures no longer move the viewfinder camera.
- Livery orientation | Liveries and templates no longer land upside down on vehicles loaded through the CodeWalker bridge.
- Ground grid | The viewer's Ground grid toggle works again.
- EUP wrist props | Watches and bracelets sit on the wrist instead of the back of the hand.
- Showroom floor | Reflections of lit sirens and lamps no longer shimmer as the vehicle turns.

---

# PRISM
version: 4.1.0
date: 2026-08-12
> PRISM cleans up the whole Studio and makes templates, previews, updates, and feedback easier to use.

## New
- Theme presets | 12 color presets with separate System, Light, and Dark choices.
- EUP templates | Template Generator supports `.ydd` files and exports each drawable separately when needed.
- Native materials (experimental) | Load materials from game textures while manual textures stay the final choice.
- Feature requests | Feedback now takes feature requests as well as bug reports.

## Improved
- Template Generator | Rebuilt workspace with Model, Template, and Split views, better marker tools, zoom controls, model rotation, and a free camera.
- Studio layout | Cleaner Home, first-time setup, Settings, viewer sidebars, tabs, and toolbar.
- Lighting | Smaller lighting controls you can adjust by dragging, with presets, the keyboard, or sliders.
- Template formats | YFT and YDD files keep their real format, so UVs, materials, and mesh selection work correctly.
- Updates | Updates download in the toolbar and install when you restart the app.
- What's New | Release notes rebuilt with simple filters and better keyboard support.
- Right-click and tooltips | A global right-click menu and Studio tooltips that follow the current theme.

## Fixed
- Interface fixes | Theme colors, active tab seams, interface scaling, high-DPI framing, and context menu positioning.
- Preview export | Open Folder works reliably and shows an error when it fails.

---

# ROAN
version: 4.0.0
date: 2026-07-02
> Named after the Roan Mountains and Roan Highlands on the Tennessee and North Carolina border.

## New
- Vehicle slot colors | Paint primary, secondary, accent, and glass materials separately in Livery and All Textures.
- CLMESH model cache | A binary mesh format between the CodeWalker bridge and the viewer: smaller payloads, faster loads, and UV2 to UV4 channels.
- Skeleton parsing | The YFT parser reads skeleton and bone data for models that rely on bone transforms.
- Light dome | Drag one control to set light direction (0 to 360°) and elevation (0 to 90°) together.
- Preview watermarks | Stamp text on preview captures with your own font, size, color, opacity, position, and rotation.
- Context menus | Right-click menus across the interface in Cortex Studio styling.
- TIFF textures | TIFF textures decode natively.
- AVIF textures | AVIF is now a supported texture format.
- Console log for bug reports | Console output can be included in a bug report.
- Save failure notice | A toast tells you when workspace storage is full instead of failing silently.

## Improved
- YFT loading | Models load through a `.clmesh` cache and `manifest.json` instead of JSON mesh output.
- Opening files | `file://` paths are fully decoded, and pending file opens are handled more reliably.
- CodeWalker bridge discovery | One search covers publish output paths, with a build-from-source fallback when needed.
- PDN decoding | Paint.NET files decode in a background worker with a native fallback.
- Texture loading | A new DDS decoder handles DXT1, DXT3, DXT5, BC4, BC5, BC7, and common uncompressed formats; DDS, PSD, PDN, and AI files are recognized by their contents.
- Multi-angle capture | Pick camera angles (Front, Back, Side, 3/4, Top), set the zoom, and follow progress while capturing previews.
- Camera framing | Better auto-framing, and the camera keeps its state across model swaps and preset changes.

## Fixed
- YTD staging errors | Failed YTD staging during conversion now reports an error instead of being ignored.
- Open-file recovery | Pending file opens recover from a poisoned lock instead of crashing.
- Camera presets | Choosing 3/4 view and then moving the camera no longer tilts the world.

---

version: 3.8.1
date: 2026-04-06

## Fixed
- Camera bug fixes

---

version: 3.8.0
date: 2026-03-31
> Model shadows, a warning for a missing set file, and manual marker selection in Template Generator.

## New
- Model shadows | Shadows on models for better depth perception.
- Missing set file warning | A warning when no set file is configured for capturing previews.
- Manual marker selection | In Marker Edit Mode, pick markers with Alt, Ctrl, or Shift and click; selections stay staged until you confirm.

## Improved
- PDN support | Better Paint.NET file handling and compatibility.
- Template markers | Generated PSDs paint only the markers you selected, and the Regenerate Behavior setting is gone.

## Fixed
- Interface fixes | Various UI improvements and polish.
- Camera presets | Choosing 3/4 view and then moving the camera no longer tilts the world.

---

version: 3.7.0
date: 2026-03-08
> Template Generator arrives in beta, along with the Cortex Software palette and branded light and dark themes.

## New
- Template Generator (beta) | Generate layered `.psd` templates from `.yft` models with a live preview and saved workspaces.
- Template exports | Save templates as `.psd`, `.png`, or both, remember output folders, and open them from Cortex.
- Template diagnostics | Download the template map JSON, check world-space normal and wireframe diagnostics, and report failed generations.
- Cage wireframe | An optional cage-style mesh overlay for inspecting models.
- Recents | Pinned projects, search, sorting, better grouping, and Template Generator as a launch target.

## Improved
- Cortex Software palette | The desktop UI follows the website's brand colors and typography.
- Light and dark themes | Branded light mode by default, dark mode colors, and a dark mode toggle in Settings.
- Branding | Updated title bar, release notes, select menus, app icon, and logo.
- Viewer controls | Reorganized viewer panels, refreshed light and material controls, and Exterior Only is back.
- Background template builds | Template generation can run in a background worker so the UI stays responsive.
- Template extraction | Faster mesh extraction, UV shell mapping, color generation, and previews on complex models.
- Livery application | Smarter UV selection and wrapping avoid unneeded remaps when applying a livery.

## Fixed
- Exterior Only | Better hiding of interior, glass, wheels, and window targets.
- Model compatibility | Sturdier YFT parsing for problem files, with better index buffer detection and texture coordinate handling.
- Texture targeting | More reliable livery and material mapping, UV fallback, and alpha handling.
- Context menus | Menus stay anchored through scaling and window resizes.
- Updater and PDN safety | Clearer updater errors and stricter PDN limits so bad files don't crash the app.

---

version: 3.5.0
date: 2026-02-18
> Window textures per model slot, YDD models in multi-model mode, and full workspace restore.

## New
- Window textures per slot | Each slot in multi-model mode gets its own window texture for A/B templates.
- YDD in multi-model | Drag and drop `.ydd` files into the side-by-side comparison.
- Workspace restore | Recent projects reopen with their model paths, textures, colors, and camera positions.

## Improved
- Glossiness and body color | Sliders are much smoother because material updates skip redundant scene passes and texture reloads.
- Interface | Sharp corners instead of rounded ones, compact file labels, and more consistent layout.

---

version: 3.1.1
date: 2026-02-10

## New
- Open from Explorer | Open `.yft` and `.ydd` files from Explorer; the running app takes the file instead of opening a second window, including in multi-model mode.

## Fixed
- Window controls | Elegant window mode shows up in the window controls selector.
- 3D grid setting | The 3D Grid option shows in Settings.
- Variant Builder startup | Variant Builder no longer errors on startup.
- Multi-model live reload | Automatic livery updates register on both model slots.

---

version: 3.1.0
date: 2026-02-08
> PSD Variant Builder arrives, and Cortex Labs becomes Cortex Studio.

## New
- PSD Variant Builder | Read PSD layers and groups with their hierarchy, manage variants, preview changes in 3D instantly, and batch export every variant to PNG up to 4K.
- Recents toggle | Choose whether recent sessions show on the home screen.
- Workspace auto-save | Your session is saved and restored automatically.

## Improved
- New name | Cortex Labs is now Cortex Studio.
- Interface overhaul | A new Cyber look with dark backgrounds and cyan accents.

---

version: 3.0.0
date: 2026-02-06
> Side-by-side models, live texture reloading, and EUP clothing support.

## New
- Multi-model viewer | Compare two models side by side with separate texture controls.
- Live texture reloading | A native file watcher spots saves and reloads in milliseconds.
- Light intensity | Adjust the scene lighting.
- Glossiness | Fine-tune material roughness.
- EUP mode | Support for `.ydd` clothing and EUP models.

## Improved
- Simpler viewer | Bundled YTD assets removed and the viewer simplified.
- YFT detection | Better YFT auto-detection and material targeting.

---

version: 2.3.3
date: 2026-01

## New
- Update checker | A notification tells you when an update is available.
- YTD texture browser | Browse YTD textures with automatic mapping.

## Fixed
- DDS orientation | DDS textures no longer load upside down.

---

version: 1.0.0
date: 2025-12
> The first release.

## New
- YFT models | Load `.yft` models directly.
- DFF models | Load `.dff` models.
- Texture modes | Livery and All Textures modes.
- Camera | Camera presets and orbit controls.
- Colors | Body color and background color controls.
- Hotkeys | A hotkey system.
- AI textures | `.ai` texture support through PDF.js.
- Onboarding | A first-run onboarding flow.
