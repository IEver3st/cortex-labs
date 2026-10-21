# Changelog

All notable changes to Cortex Studio are documented here.

---

## Unreleased

---

## [5.4.0] - 2026-10-21

Build addon packs in EUP Studio's new Pack tab, set each item's sounds, game flags, hat hair and heel height, and build the creature metadata the game reads for hats and heels.

### Added

- **Pack tab in EUP Studio** - Building an addon pack moves from a dialog into EUP Studio's new **Pack** tab, and **Build an addon pack** on EUP mode's Model step opens it. The tab lists the items for the ped on screen by slot, with the numbers they get in the new pack. Click an item to wear it; Ctrl-click or Shift-click selects several in one slot. Move items with the row arrows or Alt + Up and Alt + Down to renumber the slot, or turn off **In the pack** to leave one out without deleting anything. The pack's name, folder, order and item settings are saved with the session. Desktop app only.

- **Clothing properties** - Each item starts with the settings its pack's `.ymt` gives it, and you can change them for one item or several: **Sound** and **Footsteps**, prop **Transparency**, **Game flags** (hidden in first person, not in vehicles, armoured, lightly armoured, fire retardant, bulky, and the helmet and physics hat flags on hats), **Flatten hair** on hats, **Squash under hats** on hair and **Heel height** on shoes. The viewer flattens the hair under a pack hat by its **Flatten hair** value as you drag, so a hat at 0% leaves the hair alone. Heel lift is not shown in the viewer.

- **Creature metadata** - When a pack has hats that flatten hair or shoes with a heel height, the build adds `mp_creaturemetadata_mp_m_<name>.ymt` (`mp_f_` for female items), the file the game reads those values from. It is made from the new pack's own items; a source pack's creature metadata is not copied.

### Changed

- **Addon pack checks** - A source pack whose `.ymt` can't be read now stops the build until you fix the file or remove its folder, instead of building its items with default settings. When identical models merge, the merged item keeps the settings of the first of them in folder order, and the checks say when another one's settings go unused.

---

## [5.3.5] - 2026-10-19

Write your own textures into EUP clothing, and build addon packs from folders of clothing, merging packs that share a model.

### Added

- **Add and replace clothing textures** - EUP mode's new **Textures** tab lists the textures of the clothing item you opened, a to z, and writes your images into it. Drop images on the tab, or pick them with **Add textures**, to add them as the next letters; drop one on a texture to replace it. Adding textures also raises the item's count in the pack's `.ymt`, so that file must be in the same resource. **Write N textures…** shows every file it changes or adds and checks for scaled-up or stretched images. Replaced files and the `.ymt` get a `.bak` first, a failed write puts back what it changed, and a `.ymt` edited outside Cortex since it was read stops the write. Only legacy GTA V texture files can be written. Desktop app only.

- **Build an addon pack** - **Build an addon pack** on EUP mode's Model step makes a new FiveM resource from folders of freemode clothing, such as addon packs or loose files from a clothing tool. Every item is numbered again in the new pack, and `fxmanifest.lua`, the shop metas and the `.ymt` files are written for you; a slot with more than 128 items or 255 textures continues in a second pack in the same resource. **Merge identical models** turns items whose model file is byte for byte the same into one item with all their textures, so several recolour packs for one vest become one vest. Source folders are only read, the new resource never replaces an existing folder, and Cortex does not copy from escrowed resources, encrypted or GTA V Enhanced files, the GTA V install or FiveM's own files. Each pack's licence still applies to its clothing. Creature metadata (how hats sit over hair) is not carried over yet. Desktop app only.

---

## [5.3.0] - 2026-10-16

Open a folder of vehicles to see a whole pack as snapshots and go through it car by car, and remove liveries a vehicle came with.

### Added

- **Go through a folder of vehicles** - **Open a folder of vehicles** on Vehicle mode's Model step shows every vehicle in a pack, or a folder of packs, on a new **Pack** view: a snapshot of each car, the liveries staged for it and any meta errors. Click one to work on it in the **Vehicle** view, which keeps the folder at the top of the dock; step through them with its arrows or **Alt + PageUp** and **Alt + PageDown**. Snapshots are taken as you open each car and kept in Cortex's cache, and **Take snapshots** fills in the rest in one go, or retakes them all once none are missing. A resource's `vehicles.meta` decides what counts as a vehicle, so mod kit parts kept beside the car stay out, even when you pick the resource's `stream` folder; **Filter vehicles** narrows the pack by model name, display name or resource. Liveries staged but not yet written stay with each vehicle while you move between them. Desktop app only.

- **Remove liveries** - In the **Liveries** tab, the bin on a livery already in the vehicle marks it for removal, so a vehicle that came with four liveries can be left with your three without opening OpenIV. Its name is struck through until you write, and the undo arrow keeps it. The write removes it from every texture dictionary that holds it, in the same all-or-nothing write as your new liveries and after the same `.bak` backups; **Remove N liveries…** writes removals on their own. **Checks** warns about gaps in the numbers, and a write that would leave a dictionary with no textures is refused.

---

## [5.2.0] - 2026-10-16

Vehicle mode brings Livery and All together, and its new Liveries tab writes a whole set of liveries into a vehicle at once.

### Added

- **Write liveries in bulk** - The new **Liveries** tab in Vehicle mode lists the vehicle's liveries as the game numbers them (`<name>_sign_1`, `_sign_2` and so on) and writes a whole set of your images into the vehicle at once. Click a livery to preview it. Add images with the picker or drop them on the tab: they are numbered after the vehicle's liveries in file-name order, up to livery 99, and an image dropped on a livery replaces it. **Write N liveries…** shows every texture dictionary it changes and at what size, and checks for scaled-up or stretched images and gaps in the numbers. Images are fitted to the size each dictionary's liveries already use and stored as DXT5; a DDS already at the right size goes in unchanged. Every `.ytd` is backed up first, **Stop** changes nothing, and if a write fails the files already written are put back. Restart the resource in game to load the new liveries. PNG, JPG, WebP, BMP, TIFF, PSD, PDN and DDS images are read. Only the legacy GTA V texture dictionaries beside the model can be written; escrow-encrypted ones can't be read. Desktop app only.

### Changed

- **Vehicle mode replaces Livery and All** - One **Vehicle** workspace (Alt + 1) now holds everything for a vehicle: the inspector's **Paint**, **Liveries**, **Mods**, **Scene** and **Meta** tabs, Kit shoot, saved builds and the model's own textures. The livery goes on the detected paint as before, and **Apply to** can switch it to all meshes or one material or mesh, so template checks no longer need a separate mode. The glass step gets the same choices, plus **None**. The in-game livery switcher moved from **Mods** to the top of **Liveries**. Livery and All projects, recent tabs and saved vehicles open in Vehicle with the targets they used. Alt + 2 is free: a custom shortcut for the old New Livery Tab now opens Vehicle, and one for New All Tab is dropped. In the bug report form, the Livery and All Textures areas are now one **Vehicle** area.

- **Clearer texture write errors** - When a texture dictionary changed after Cortex read it, **Write to textures…** now says the texture can no longer be replaced or added, instead of asking you to check the lenses again.

- **Source code is public** - Cortex Studio's source is published in the public repository under the Cortex Studio Source-Available License 1.0. You can use the app for anything, including commercial work, and build or modify it for your own use. Redistributing, reselling, or rebranding it is not allowed. See `LICENSE` and `SECURITY.md`.

### Security

- **Tauri 2.12** - The desktop runtime and its plugins move to Tauri 2.12, which fixes an origin check that could let a remote page call app commands meant only for local pages. Patched Rust crates (rustls, rustls-webpki, quinn-proto, tar, time, serde_with) and Next.js 16.3.8 for the documentation site ship with it.

---

## [5.1.1] - 2026-10-15

Write to textures now copies lens textures only from the vehicle's own resource.

### Changed

- **Lens writes copy only from the vehicle's resource** - **Write to textures…** now adds a recoloured copy only of a texture from a pack dictionary in the vehicle's own resource. It no longer copies textures from the game's files or from another resource into the vehicle: the dialog lists the sirens whose lenses use one, and **Texture colour** leaves them as they are. The desktop app and the CodeWalker bridge check where each copy comes from before anything is written.

---

## [5.1.0] - 2026-10-15

ELS vehicles now preview and edit their lights in Sirens, Livery and All, and siren lens colours can be written into the vehicle's own textures so they show in game. The dock is tidier and lists what changed before you save.

### Added

- **ELS vehicles in Sirens** - Vehicles built for ELS (LSPDFR's ELS V8, ELS-FiveM, ELS-Plus and MISS-ELS) now preview and edit their lights in Sirens. Switch step 2 to **ELS** and Cortex Studio finds the vehicle's VCF beside the model, in its download or resource, or in ELS folders you add, flashes the model's extras by light stage the way the script does, and edits every VCF section: lights, colours and environment lights, ELS V8 groups with their stage patterns, misc and cruise, or MISS-ELS flash patterns and statics. **Save** changes only what you edited, after an exact .bak, and lists new files in ELS-FiveM's `vcf.lua`. ELS V8 pattern timings come from your own ELS-FiveM copy (**Import…** on the Pattern tables row); until then numbered patterns play a flash marked approximate. No VCF yet? **New ELS V8 VCF** or **New MISS-ELS VCF** starts one, **Save as…** writes it, and the ELS editor has undo and redo. In ELS mode the viewfinder's Sirens toggle picks the light stage. Carcols sirens stay the default for every vehicle.
- **ELS in Livery and All** - The Lights section of the Meta tab (and the Lights tab in Sirens) switches an ELS vehicle between carcols sirens and its VCF, and runs the VCF's stage, cruise, takedowns and scene lights, or MISS-ELS's pattern keys, on the model. The carcols or ELS choice, and a VCF you open, are remembered per vehicle and shared between the three tabs. In carcols mode, a vehicle with a VCF beside it gets a note that ELS drives its lights in game, so carcols edits may not show. Closing a tab or the window with unsaved ELS edits asks first, as it does for sirens.
- **ELS live reload** - The open VCF reloads when it changes on disk, so edits made in a text editor or saved from another tab show on the lights straight away. Unsaved edits in Cortex Studio are never replaced: the dock says the file changed and **Load** brings it in when you choose.
- **What changed, before you save** - With unsaved edits, the Status row of the siren setting and ELS steps opens to a list of what changed against the file: setting fields, head and tail lights, siren count, and each siren's colour, pattern, aim and other fields, grouped when several sirens changed the same way. For a VCF it lists added, removed and changed lights and the group, misc, cruise and pattern sections you touched.
- **Lens glow preview** - The Siren tab in Sirens previews the lens of the selected sirens in another colour: **Siren** follows the siren's carcols colour, **Custom** takes any colour. The colours are kept with the tab. **Reset all** clears the preview colours; it does not undo a write.
- **Write lens colours to textures** - In game a lens glows in its texture's colour whatever carcols says, so **Write to textures…** (desktop app, once a siren has a lens colour) recolours the parts of the lens textures the tinted sirens light, inside the vehicle's own `.ytd` files. A texture the vehicle shares with its pack or the game gets a recoloured copy in the vehicle's dictionaries, so other vehicles keep theirs. Before anything is written, the dialog lists each texture, the other lights that use the same part of it and change too, and textures stored in another format (such as BC7) that are written as DXT5. Sirens that light the same part of a texture can only glow one colour: the dialog groups them and lets you pick that colour, or the texture's own, in place. Textures stored inside the `.yft`, and vehicles without a `.ytd` of their own, can't be written. Each file gets a dated `.bak` first, and if one file fails the others are put back. Afterwards the lens glow returns to Texture and the model reloads with the new colours, keeping your view; restart the resource in game to load them.
- **Open the _hi model** - Opening a vehicle `.yft` that isn't the `_hi` model offers **Open _hi model** when that file is in the same folder. **Never show this again** turns the warning off, and Settings > Viewer > Standard Model Warning turns it back on. Desktop app only.

### Changed

- **Tidier dock** - The vehicle step's texture state (the model's own textures, loaded, meshes, not found) and its read warnings, the siren setting step's status and checks, and the ELS step's status, format, checks, pattern tables and folders, are now one aligned row each instead of paragraphs. Lists such as warnings and checks open from their row; a closed Checks row still counts the most serious kind (blocking, warnings or notes) in its colour.
- **Model step actions** - Replace and Unload are icon buttons on each loaded file's card instead of a row of their own. Save vehicle is now the **Saved vehicle** row under the model: closed it names the saved vehicle or offers **Save**, open it takes the name (Enter saves, Escape closes) or offers **Update** and **Save as new**.
- **Capture folds away** - The Capture footer in Livery, All, EUP and Multi starts collapsed to one line and remembers whether you opened it. It opens by itself while a capture runs or its result is showing.
- **File warnings match the studio** - The standard model, unsupported image and high bit depth PSD warnings use the studio's dialog style, with readable titles in light and dark themes. The unsupported image warning now lists every format the viewer reads instead of three. Escape, the close button and clicking outside all dismiss them.
- **Siren ids above 255** - A siren setting with an id above 255 gets a note in the checks: singleplayer (LSPDFR) reads it only with SirenSetting Limit Adjuster installed.

### Fixed

- **Presets restyle the selected sirens** - Choosing a preset from **Presets** in the siren sequencer now restyles the selected sirens in place, lowest number first and repeating the set as needed, and each siren keeps its aim. Before, it always added new sirens after the last one, past the model's siren bones. With no siren selected it still adds the set.
- **Importing a resource's own siren setting edits it** - Importing a setting from the vehicle's own carcols.meta opens that setting for editing, so **Install to resource** updates its id instead of adding a copy under the next free id every time.

---

## [5.0.4] - 2026-10-14

Rear and side siren lights now show on vehicles that rely on the carcols `delta` to aim them, as they do in game. This release also adds a solid wireframe view with mesh stats, and indicators keep blinking while siren playback is paused.

### Added

- **Solid wireframe with mesh stats** - A new button on the view deck draws every triangle edge over the shaded model, with hidden edges kept hidden, and opens a readout of what the viewer is drawing: triangles, vertices, meshes, GTA shaders and textures, and the model's size in metres. The counts follow exterior-only, extras and mod swaps as you change them. Works in Livery, All Textures, EUP, Sirens and Multi, and shows in preview captures.

### Fixed

- **Rear and side siren lights on more vehicles** - Some vehicles build their rear and side light heads facing forward and rely on the carcols `delta` to turn them. The game turns them; the preview did not. On those vehicles the rear lights stayed dark or hidden inside the body, and bars floated beside the vehicle. Each siren now turns its meshes to its `delta`, as in game. Vehicles whose siren bones already face their `delta` look exactly as before. A new siren setting starts each siren aimed the way its bone faces.
- **Indicators blink while sirens are paused** - Once siren playback had been paused or scrubbed, hazards and indicators froze solid on (or off), because they ran on the siren pattern clock. They now flash in real time whatever the siren playback speed.

---

## [5.0.3] - 2026-10-14

A fix for EUP's Surface sliders, which did nothing on clothing: the vehicle paint finish was applied over them every time. This release also gives EUP a showroom, stands clothing upright facing the camera, loads each item's own textures and keeps the rotate buttons on the bottom bar.

### Added

- **Showroom in EUP** - EUP tabs have the Workbench / Showroom switch: the showroom stands the clothing in a dark studio under a spotlight, with the floor, light, reflections and turntable in the Scene tab. New EUP tabs start from the EUP scene in Settings > Studio, as EUP Studio does, rim light included. Captures and saved views use it too.
- **EUP textures load with the model** - Picking a clothing model in EUP also loads its own texture dictionary (the `_diff_` `.ytd` beside it) into the Uniform slot, so the item shows its real texture straight away. A texture you picked yourself is never replaced. Turn it off with **Load EUP Textures** in Settings > Viewer. A `.ytd` can also be picked as the uniform texture by hand; it shows the dictionary's diffuse texture and reloads when you save it.
- **Undo model turns** - A reset button beside **X**, **Y** and **Z** stands the model back the way it loaded.

### Changed

- **Rotate buttons stay on the bottom bar** - **X**, **Y** and **Z** now stay on the bottom bar when Panel Camera Controls moves the camera presets into the side panel. A turn stands the model back on the floor, centred, and is saved with the workspace instead of being lost when it reloads.

### Fixed

- **EUP Surface sliders work** - Gloss, Roughness, Clearcoat and the Surface type (Paint, Chrome, Plastic, Metal, Glass) now change EUP clothing. Before, the vehicle paint finish was applied over them, so none of them did anything. Light response also brightens past 1x on light colours and textures instead of stopping at the base colour.
- **EUP clothing stands upright** - `.ydd` clothing in EUP and the Template Generator is converted from GTA's Z-up axes and faces the **Front** shot, instead of lying on its back.

---

## [5.0.2] - 2026-10-14

Custom characters, props and an animation timeline in EUP Studio, in-game liveries and saved vehicles, mod kits in Sirens, numbered siren callouts, undo in Variant Builder and the Template Generator, tabs that reopen where you left them, and lamps, lenses and glass that light and layer the way they do in game.

### Added

- **In-game liveries** - The **Mods** tab in All and Sirens has a **Livery** picker that switches between the liveries the vehicle has in game: the texture liveries in its texture dictionary (`<name>_sign_1`, `_sign_2` and so on, what `SetVehicleLivery` picks between) and the livery mods in its mod kit. Previous and next buttons step through them. Texture liveries use the kit's `liveryNames` text when the resource has it. A livery mod covers a texture livery, as in game, so picking one clears the other. Livery mods are no longer listed under Parts, where they fitted an empty placeholder; the picker applies their livery, and **All stock** leaves the livery alone. Liveries need **Use the model's own textures**, the section says when a texture you loaded covers the meshes a livery would change, and the choice is saved with the workspace and with saved vehicles.
- **Saved vehicles** - **Save vehicle** under the model in Livery, All and Sirens keeps the vehicle's setup under a name: its mod kit parts, in-game livery, paint, extras, plate (even one that follows the Settings default), the meshes picked under **Apply to**, the window overlay and, in Livery and All, the livery. Saved vehicles appear on Home, up to 200. Opening one switches to its tab if one is open, or reopens the project made from it, as long as the model is still on your PC. A tab opened from a saved vehicle offers **Update** to save over it. If the model has moved, Home marks it as not found and **Locate** points the saved vehicle at its new path, and the vehicle renamer moves saved vehicles along with the model. A deleted vehicle can be brought back with **Undo**. Nothing is written to your model or resource.
- **Mod kits in Sirens** - The Sirens inspector has a **Mods** tab, so you can fit a vehicle's mod kit parts (lightbars, push bars, antennas) while you program its lights. Picks are saved with the workspace and with saved vehicles.
- **Custom characters in EUP Studio** - The Character step can put any ped from your GTA V files, or your own ped's files, on the stage instead of the freemode ped. Each character in a two-character scene keeps its own choice. When your files hold more than one ped, EUP Studio lists them to pick from, and **read them again** reloads them after you edit them. When they hold two copies of one file, it uses the one nearest the folder you opened and says so. EUP clothing, addon pieces, saved outfits, Lua export, colourway sheets and thumbnails stay with the freemode peds; with another ped on stage those panels say so. Saved views, shots and videos are named after the ped.
- **Ped variations and character props** - For a game ped or your own ped, the Body tab picks a drawable and texture per component from the ped's variations file, and puts its hats, glasses, earrings, watches and other props on their anchor bones.
- **Animations on any ped** - Poses, game clips, your `.ycd` clips and held props work on custom characters. A clip made for a different skeleton keeps the ped in its rest pose and says why.
- **Props on set in EUP Studio** - The Scene tab can stand up to 24 props on the floor around your characters, from the game files or your own `.ydr`, `.ydd` or `.yft`. Click one in the list or the viewfinder and move or turn it with the gizmo or exact fields; hide, duplicate and remove it with Undo. Props appear in views, shots, colourway sheets and videos, but not in batch thumbnails, and camera presets still frame the characters. G moves, R turns, Delete removes and Ctrl+Z brings back the selected prop. While a prop is shown, a walking character walks in place on a still floor. With Reload when files change on, saving a prop's file reloads it where it stands. A prop whose file is gone says so, and **Locate** points it at the new file without losing its place; one that fails to load offers **Try again**. A prop from another drive loads again after a restart.
- **Animation timeline in EUP Studio** - The Pose step has a frame scrubber with frame and time readouts, playback at 0.25x to 2x, and a loop switch. The session remembers the speed, the loop setting and the frame you paused on.
- **Place held props by eye** - A held prop can be dragged and turned with a gizmo in the viewfinder; letting go writes its new bone offset and rotation into its fields.
- **Save This View shortcut** - Alt + P saves the viewfinder as framed in Livery, All, EUP, Multi, EUP Studio and Prop Studio, and takes the photo in Photo Mode. Change it in Settings > Shortcuts. If you already use Alt + P for something else, your binding stays and Save This View starts without a shortcut.
- **Save this view in Multi** - Multi saves the lineup exactly as framed, without the move gizmo, to your preview folder with your watermark.
- **Tabs reopen where you left them** - Project tabs that were open when you closed Cortex Studio come back at the next start, in the same order and with the same tab in front. Each loads its model the first time you switch to it, and a file opened with Cortex Studio still opens in front.
- **Ask before losing siren edits** - Closing a tab, or the app, while a siren setting has edits that aren't saved to a carcols.meta now asks first. **Keep editing** cancels.
- **Undo in Variant Builder** - Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) undo and redo variant and layer changes, and a deleted variant comes back with the Undo link under the list.
- **Undo for template markers** - Drawing, moving, nudging, filling, deleting and clearing Template Generator markers can be undone and redone with Ctrl+Z and Ctrl+Shift+Z or the buttons on the deck.
- **Variant renders** - With a vehicle loaded, Variant Builder can also save each variant on the car as `<name>_render.png`, from the vehicle view as framed.

### Changed

- **Extras and plates are saved with the workspace** - Extras you switch by hand and plate edits come back when you reopen a vehicle workspace from Home or restart Cortex Studio, as mod kit parts already did.
- **Siren callouts** - Siren markers on the model are now numbered callouts: a small dot on each light and, on a short leader beside it, its number in the siren's colour. Heads that sit together share one label, labels move clear of each other as you orbit, and lights on the far side of the body fade back. The pin menu in the sequencer's bar switches between callouts, the previous **Classic** chips and **Off**, and remembers whether you chose callouts or Classic.
- **Roomier siren sequencer** - In a narrow window, the preview column in Sirens now gives way so the sequencer keeps at least 560px, and a narrow sequencer tightens its row heads so the steps get the width. The step ruler no longer prints the playing step over its neighbour.
- **Themed dropdowns everywhere** - The last plain system dropdowns (ULC button colours, the bug report's area, Prop Studio's drawable, Template Generator's part picker, and the floor, plate style and watermark font settings) now use the same dropdown as the rest of Cortex Studio.
- **Tidier tool results** - The ULC builder, vehicle renamer and Sirens tool results show one short line per step with an icon, and each file as its name. Click a file to open its folder; hover it for the full path.
- **Horn in Lights** - With a ULC config, the Lights tab always shows **Horn**. It previews the config's horn extras, or says that `useHorn` is off and where to turn it on.
- **Faster game textures** - A vehicle's own textures finish loading about a third sooner, and the viewer no longer stutters while they stream in. Each material now prepares its shader once instead of once per texture that arrives.
- **Faster mod kit parts** - The first mod kit part you fit no longer waits several seconds while Cortex Studio indexes GTA V's shared textures; that now happens in the background as soon as the vehicle's mod kits are found. Fitted parts also land with their textures already on, instead of landing grey and repainting.
- **Custom animations reload by themselves** - With Reload when files change on, saving the custom `.ycd` you are playing reloads it on the frame you were watching. The Reload button still works.
- **Shortcuts work in every studio** - Toggle Control Panel, Reset View and the camera presets now work in EUP Studio (Front, Back and Side; it has no 3/4 or top shot), Prop Studio and Photo Mode, Select Model opens a prop in Prop Studio, and the layers panel in Variant Builder follows Toggle Control Panel (Ctrl + \ still works).
- **No more clashing shortcuts** - Settings says when the keys you press already belong to another action and offers to swap them. Older settings with a clash show it under both rows. Tab, Enter, Backspace, Delete, Space, the arrow keys, Home, End and Page Up and Down need Ctrl or Alt, and Escape and the lock keys can't be used. A shortcut added in an update stays unset if you already use its keys.
- **Same project from every start** - Starting a workspace from the new-tab menu or the first-run screen now saves it as a project and lists it on Home, like Home and the hotkeys already did, and every entry point names it the same way.
- **Ask before replacing** - Preview captures in Livery, All and EUP and Variant Builder exports now ask before overwriting files that already exist, like EUP exports.
- **Watermark on more captures** - Stamp captures now also marks Photo Mode photos, saved views in Prop Studio, EUP and Multi, EUP shots and colourway sheets, and Variant Builder renders. Textures, templates, videos, EUP thumbnails and Prop Studio image exports stay unmarked, and Settings says so.
- **Variant exports keep their shape** - Non-square layered files export at their own proportions, with the long side at the chosen size. Pick Square to stretch them as before.
- **Start in Exterior Only** - Settings > Viewer can start new Livery and All Textures workspaces in Exterior Only again. Open workspaces keep their own setting, and the camera deck still toggles it.
- **Clearer render effect settings** - Settings > Viewer now says that Show 3D Grid, Ground Shadows and Ambient Occlusion apply to Livery, All Textures, EUP, Multi and Sirens tabs, while EUP Studio, Prop Studio and Photo Mode keep their own with each workspace.
- **Problems reading a model are listed** - Textures the CodeWalker bridge couldn't export, and other problems it worked around while reading a model, now appear as notes under the model and on the vehicle's slot in Multi, instead of textures silently missing.
- **Safer file access** - Cortex Studio can no longer write into AppData, the Windows Startup folder, PowerShell profile folders, `.git` folders or hidden folders in your user folder, or the install folder, or into folders whose name ends in a dot or a space or contains `~` and a digit (Windows short names). It can no longer read Windows credential, browser profile and Discord folders, or hidden folders in your user folder, so textures kept in a folder such as `.config` no longer load.
- **Models are read again once** - The first time each model opens after updating, Cortex Studio reads it from the game files again instead of its cache, so that first open is slower.
- **Window overlay follows Settings on a new model** - Loading a model in All or EUP now starts the window overlay's **Apply to** at the Settings default, detected window materials, instead of resetting it to None.
- **Template Generator out of beta** - The Template Generator tab and its new-tab menu entry no longer carry a Beta badge.
- **A resource's own .ytd replaces the game's** - A vehicle named after a base-game one now uses only its own texture dictionary for that name, as in game. Textures it lacks show as not found instead of the game's version. The same goes for any texture dictionary the resource streams itself, props included. Parent dictionaries the resource doesn't stream, and vehshare, still come from the game.

### Fixed

- **See-through lamp housings** - Glass on the vehicle's own textures is now as opaque as its texture says, as in game. Lamp housings and reflectors modelled with the glass shader (the GSD 2024 Explorer's head and tail lights, for one) were drawn at under half strength, so you could see into the car through them. Windows keep the see-through their texture gives them.
- **Running lights** - Daytime running lights, side markers and lit screens built on the game's default light (`vehicle_lightsemissive` light id 0 outside sirens and extras) now glow whenever any vehicle light is on, as they do with the engine running in game. Before, they never lit.
- **Headlights and tail lights burn through their lenses** - Lit lamps fill their lens the way the game's bright emissive does, so a headlight reads as one lit lamp instead of scattered highlights, and faint glow cards stay a soft haze instead of a speckled disc. A coloured lens in front of a lamp now tints its glow, so tail lights built as a white reflector behind a red lens burn red instead of white or pink.
- **Light extras switch instantly** - Extras the vehicle state switches (park and drive patterns, sirens, brakes, reverse, horn and ULC buttons) now appear and disappear at once, as in game, instead of bolting on like mod kit parts. Extras you switch by hand still animate.
- **Siren markers stay on their lights** - While you orbit, the siren editor's dots, callouts and classic chips move with the model in the same frame. Before, they trailed the camera during a drag and swung tens of pixels off their lights, then snapped back when you let go.
- **No false "resource folder" error after saving** - Saving in the ULC builder, renamer or siren editor no longer flashes "The resource folder is not known yet" or "no resource" while Cortex Studio re-reads the resource. The roof animation also stays loaded through that re-read.
- **Solid tail light lenses** - Lamp lenses, glass and decals now draw in the model's material order, as in game, so a tail light lens covers the reflectors, emitters and cabin decals behind it. Before, the viewer sorted see-through parts by depth and drew glass first, so lenses such as the 24 Explorer's looked transparent and showed the cargo area through them. Glass also no longer lets a little of the cabin through where its texture is fully opaque.
- **Hidden lights no longer float** - Vehicles that box lamps in with an invisible badge until a mod kit part is fitted (a fully transparent `vehicle_badges` mesh, such as GSD's `emiblocker`) now hide those lamps' lenses and glow, as in game. Fitting the mod that turns the blocker's bone off reveals them. Before, the lamps floated in mid-air in front of the bumper. Only closed boxes count as blockers: a blank livery decal (`_sign_1`) or a blank window decal template stays an ordinary transparent decal, so lenses on those panels and rear deck or interior lights behind the glass stay visible.
- **Flashers inside head and tail lights** - Emergency lights built into lamps (flashback reflectors, hideaways, fog flashers) now glow across the whole reflector in the colour their texture gives them, as in game. Before, only the small LED dots lit up, and a red flasher could glow blue because the viewer tinted it with the siren's carcols colour. Carcols colours still drive each siren's corona and the light it casts. Steady-burn extras, such as a ULC cruise button, light their reflectors the same way.
- **Lens scratches no longer sparkle** - Scratch and grain layers on lit head and tail light lenses stay barely visible, as in game. Before, they lit up as a dense field of glowing specks across the lens.
- **Upside-down uncompressed textures** - Vehicle textures stored uncompressed (A8R8G8B8 and similar, common for lamp textures such as `veh_lits`) were drawn upside down, so lamps took their colour and shape from the wrong part of the texture. On the GSD 2025 Tahoe the running lights glowed red and the tail lights lit as white streaks. They now read the same way round as compressed textures and the game.
- **Faint running lights** - Daytime running lights whose texture is nearly transparent (as low as 2/255) now burn solid white, as in game, instead of staying dark. Scratch layers on steady-burn extras, such as a ULC cruise button's in-lamp films, stay a faint haze even when their texture has no mipmaps.
- **Switching models mid-load** - Opening another model while one is still loading no longer lets the first one replace it when it finishes. The first one's parse stops, so the new model doesn't wait behind it, and no error appears for the model you replaced. The new model can still take a few seconds while the bridge indexes the game files again.
- **Closing while a model loads** - Cortex Studio now closes right away even while a model is still being parsed, and no CodeWalker bridge process stays behind, even after a crash.
- **Edited files show up** - Reopening a model after saving it from your modelling tool, or after editing its `.ytd`, `vehicles.meta` or `.ytyp`, shows the new version instead of an earlier copy.
- **No broken cached models** - A model whose parse was interrupted or failed is parsed again the next time it opens, instead of failing on a half-written cache. A damaged mesh cache is rejected instead of drawing stray triangles.
- **Paint.NET files look like Paint.NET** - A `.pdn` texture now shows what Paint.NET shows: hidden layers stay hidden, layer opacity applies, and layers set to Multiply, Overlay, Screen or any other Paint.NET blend mode flatten the way Paint.NET draws them. The Variant Builder lists the file's real layer names and previews and exports those blend modes the same way. A damaged file or an old Paint.NET 3 file shows an error that says why instead of a wrong image.
- **Load errors name the file** - A livery, window template, background image, texture map or `.dff` model that can't be read now shows an error with the file name instead of doing nothing. A livery that is briefly locked while your editor saves it keeps showing until the next save.
- **No freeze after a slow texture** - When one texture takes too long to decode, only that texture fails. The rest keep decoding in the background instead of all decoding at once on the main thread.
- **16-bit texture maps keep your livery** - Dismissing the 16-bit warning for a material texture map no longer unloads the livery.
- **Illustrator textures clean up** - Loading an `.ai` texture no longer leaves a PDF worker running in the background each time.
- **Steady viewfinder while saving photos** - Saving a photo in Photo Mode no longer flashes the viewfinder at the output size or leaves the move gizmo showing.
- **Blurred backgrounds the right way up** - A blurred background image is no longer shown upside down.
- **Save this view keeps your framing** - With a watermark set, Save this view saved the 3/4 shot instead of the view on screen. It now saves what you see.
- **Honest preview captures** - Capture in Livery, All and EUP now counts only the shots it actually wrote, names any angle that couldn't be captured, and shows why a run stopped and how many files it saved. Every shot of a run lands in one folder.
- **Clearer export failures** - Template export reports a locked file or full disk with its path instead of opening a save dialog. A cancelled EUP export says how many shots were saved and where. Folder and file-picker failures in Photo Mode, Prop Studio, EUP, Variant Builder and Template Generator now show a message.
- **Save this view in the browser** - In the browser preview, Save this view downloads the PNG; capturing angles says it needs the desktop app instead of doing nothing.
- **Picked meshes survive reopening** - Meshes chosen under **Apply to** for the texture and the window overlay are restored when you reopen a project or saved vehicle, instead of resetting to all meshes and none.
- **Projects survive a missing model** - Reopening a project whose model can't load, from a disconnected drive for example, no longer saves over its mod kit, extras, livery and other setup.
- **Saving Settings keeps each tab's choices** - Saving Settings no longer resets Exterior Only, the window overlay, its target and the backdrop colour in open tabs. A changed window or backdrop default still reaches tabs that were using the old one.
- **More of the viewer is saved** - Projects now keep the wheel angle, the light direction, cage wireframe, the Lights panel switches and sliders, and the Materials panel. Removing the model or texture is saved too, so it no longer comes back on reopen.
- **Damaged project data opens safely** - A project with an unknown mode or a damaged Variant Builder list opens with defaults instead of breaking the tab.
- **Template background colour** - Auto Template Background in Settings > Appearance now sets the background of templates the Template Generator builds. Before, templates were always black behind the UVs.
- **Multi uses your showroom floor** - New Multi lineups start on the floor chosen in Settings > Studio > Vehicles. Saved lineups keep their own floor.
- **Multi live reload** - If one livery in a Multi lineup can't be watched, the others still reload live and a message names the one that won't.
- **New-tab shortcuts behind dialogs** - Alt + 0-9 no longer open tabs behind the first-run screen or the unsaved-edits question, and close Settings when it is open. Holding one no longer opens a tab per key repeat.
- **Pickers you can't see** - Ctrl + L and Ctrl + G no longer open the texture or glass picker in Sirens, and Ctrl + G waits until the glass step is on screen.
- **Hotkeys docs** - The Hotkeys page in the docs lists Reset View, the camera presets and Save This View, and says where each shortcut works.
- **Feedback from the desktop app** - Send feedback works in desktop builds that include a feedback endpoint, and builds without one say so when the dialog opens.
- **Renaming keeps the setup** - After the vehicle renamer moves a model, the reopened vehicle keeps its mod kit parts, extras and in-game livery. Before, the reopened model lost them.
- **Models with damaged light or wheel data open** - A wheel or light with a broken transform is left out and listed as a note under the model, instead of the whole model failing to load. A model with other invalid numbers says so and asks you to re-export it, instead of showing a .NET error.
- **Unreadable models fail sooner** - A model the CodeWalker bridge can't read reports its error once, instead of parsing again in a fresh process and making you wait twice for the same error.
- **Clearer rename failures** - If renaming a vehicle fails partway and can't be undone, the message says so and what is still renamed, instead of "Nothing was renamed".
- **Edited texture dictionaries show without a restart** - Opening a model again after saving its `.ytd`, with Replace on the same file or in a new tab, now shows the new textures in the same session.
- **Layer eyes after Replace** - In Variant Builder, the first click on a layer's eye after replacing the file now hides or shows it, and group and solo actions that change nothing no longer add an undo step.
- **Cancelled shortcut conflicts** - Cancelling a shortcut conflict in Settings > Shortcuts now puts the field back to the shortcut that is still in use.
- **Tab strip with many tabs** - The selected tab always scrolls into view, tabs narrow before the strip scrolls, New tab (+) stays reachable, and the mouse wheel scrolls the strip. The frame buttons no longer cover the last tab.
- **Small windows and large UI scale** - At 1024x640, including at 140% UI scale, panels no longer scroll sideways. EUP placement fields, help notes, the timeline and the camera and capture decks fit their panels. Side panels give way so the 3D view keeps its room.
- **Replace prompt in view** - When an export would replace files, the prompt scrolls into view instead of opening below the panel's edge.
- **Home on short windows** - The Home column scrolls as one, so saved vehicles and projects show whole rows, and the project search no longer overlaps the status bar at large UI scale.
- **Template marker rows** - Marker sizes no longer overlap the fill choice, and "Rebuilding…" appears below the drawing deck instead of under it.
- **Tooltips after a click** - Clicking a button no longer leaves its tooltip on screen, so closing Settings no longer leaves the gear's tooltip and focus box behind. Tooltips still show on hover and when you tab to a control.
- **Paint labels** - Paint names in Livery, All, Sirens, Multi and Photo Mode end in an ellipsis and their palette numbers stay whole.

### Removed

- **Settings that did nothing** - Hide Text Labels and the Experimental features toggle are gone from Settings. Neither changed anything, and nothing needs to be turned on for Native Materials.

---

## [5.0.1] - 2026-10-10

Mod kit parts now open with the doors and boot they are fitted to, plates take your own artwork, and mod kit picks come back with the workspace.

### Added

- **Custom plate images** - The Plate section can import your own plate design (PNG, JPG, WebP or DDS) as the background, with the chosen style's text drawn over it. Clear the text for an image-only plate. The image is read, never changed, and saved with the plate in Livery, All and Photo Mode.

### Fixed

- **Mod kit parts follow doors and the boot** - Parts fitted to a door, the bonnet or the boot in carcols, such as door badges and boot antennas, now move with that part when it opens, in Livery, All and Photo Mode. Linked models use their own `linkMods` bone. Clicking a part on a door opens the door. Photo Mode no longer shifts parts fitted to bones other than `chassis` away from the body.
- **Mod kits are saved with the workspace** - Parts picked in the Mods tab come back when you reopen the workspace from Home or restart Cortex Studio.

---

## [5.0.0] - 2026-10-09

Studio 5 rebuilds every workspace in a new paper-and-ink look and adds four new tabs: Sirens, Photo Mode, Prop Studio and EUP Studio. Vehicles now open their doors, run their lights and wear their mod kits in the viewer.

### Added

- **Sirens** - A workspace for emergency lights (Alt + 9, or Sirens on Home). Open a YFT vehicle and its carcols.meta siren setting runs on the whole textured model, on the workbench or in the showroom, and every edit shows on the model as you make it.
  - **Sequencer** - Each siren gets a 32-step lane in its own colour, painted by clicking or dragging, with play, pause, step and scrub. Rotators get a rotation lane, and the head and tail light wig-wag sequencers get lanes of their own. The playing step is outlined down every lane and a strip shows which sirens are lit.
  - **Editing** - The inspector edits every carcols field for the selected sirens and for the setting. Add, duplicate, reorder and delete sirens, append preset sets, apply pattern presets (alternating across a selection for wig-wags), shift, invert, copy and paste patterns, solo or mute sirens, and undo every step.
  - **Traffic advisor** - The Pattern menu builds arrows (first to last, last to first, centre out), chases and alternating warning halves across the selected sirens.
  - **Lens palette and facings** - Six lens colours (red, blue, amber, white, green, purple) colour the selected sirens in one click, and the Facing grid aims a siren front, rear, left, right or at a corner.
  - **Preview** - A live view of the vehicle sits above the inspector with a dot in each siren's colour where its lights are. Drag it to any size, or Expand it (or press the focus key) to fill the workspace; Esc comes back.
  - **Equipment** - The Lights tab lists every extra on the model with what it carries (siren numbers, a steady light, a ULC button) and a switch for each, which overrides ULC and the siren geometry until Reset.
  - **Install to resource** - One click updates the setting in the resource's own carcols.meta and points the model's carvariations entry at its id (`sirenSettings`), after saving a timestamped `.bak` beside each file it changes. The dock lists what changed and reports a partial write as partial.
  - **Save and import** - **Save to file…** writes the setting into any carcols.meta, rewriting only the values you changed in the file's own number format and keeping comments, spacing and other settings byte for byte; a new file holds only this setting. **Copy XML** copies the `<Sirens>` Item. **Import…** reads a setting from any carcols.meta into the editor while the model keeps its own id, name and file.
  - **ULC builder** - Writes the vehicle's Ultimate Lighting Controller entry in `ulc.lua`: vehicle names, a button per extra with label, key and colour, park and drive patterns, steady burn, and brake, reverse and horn extras, with a live preview of the Lua. Fields it does not edit and other vehicles in the file are kept, and the old file is backed up first.
  - **Rename vehicle** - Changes a vehicle's spawn name across its resource: meta elements and Lua strings that are exactly the old name, and the model's `.yft` and `.ytd` stream files, renamed together or not at all. Mod kits and parts that only start with the name are left alone. It previews every change, keeps a `.bak` of each text file and reopens the model under its new name.
  - **Checks** - Id clashes, a carvariations link that no longer matches, a missing tempo, dark patterns and siren bones the setting misses are flagged before saving. A model with siren lights and no setting can start a new one.
- **Vehicle lights** - YFT vehicles run their carcols siren pattern in Livery, All and Sirens: up to 32 sirens at the setting's bpm, `scale` emitters that grow by `scaleFactor` while lit, rotators, and coronas only where carcols sets a corona size. Siren light falls on the ground and body panels on its own side of the vehicle, with soft body shadows, and a Fog slider draws each lit spot siren as a beam of haze. Headlights, indicators, brakes, reverse and extra lights switch by the game's vertex light ids, carcols head and tail sequencers wig-wag them, and Night dims the studio. Glow, Light spill (off to 3×) and Fog are adjustable, and `vehicle_lightsemissive` panels glow only while their lamp is on, and only where their texture is bright.
- **Smart extras** - Vehicles open with no extras on, as they spawn in game. A resource's ULC `ulc.lua` drives park and drive patterns, brake, reverse and horn extras and its buttons; without one, extras that carry siren lights come on with the sirens. Steady-burn extras glow while on, manual toggles override, and the Meta tab says why each extra is on.
- **Mod kits** - A Mods tab in All lists the carcols.meta mod kit linked to a YFT vehicle and previews any part per slot on the model, including linked models, with the part's own textures and the vehicle's texture dictionary. Stock parts on the mod's `turnOffBones` are hidden, including parts skinned into shared geometry. Slots and parts use the names set in carcols `slotNames` and `AddTextEntry` scripts, and named builds are saved per vehicle model. Vehicles are re-parsed once after updating.
- **Part swap animation** - Switching a mod part or an extra drops the old part away and lands the new one from above with a short settle. Parts a model loads with, Kit Shoot captures and Reduce motion switch at once.
- **Kit Shoot** - The Mods tab photographs a whole mod kit. **Every part** shoots each part of the chosen slots on the stock vehicle or on your current picks, from the viewfinder or from the angle where each slot's parts change the most. **Builds** shoots saved builds from up to seven angles and in extra GTA paint colours. Runs can add before and after images, a labelled sheet per slot and cycle videos at 4:5, 1:1, 16:9 or 9:16. Each run writes a folder with a `kit-shoot.json` manifest and an HTML report that flags missing models and textures, parts that change nothing, `turnOffBones` that hide nothing and unnamed parts, and a review screen opens when the run ends.
- **Doors and convertible roofs** - Click a door, bonnet or boot to open or shut it, or hold Alt and drag it to any angle. Each part turns about its real hinge and stops at the model's limit, sliding doors follow their dummy's angle, and windows and trim on a part move with it. Convertibles named in vehicles.meta play their roof clip from the resource's `.ycd` or the game files.
- **Wheels and steering** - Wheels and tyres render on YFT vehicles with their own textures on every wheel the model defines, a Wheels paint slot recolours them, and the front wheels turn within the steering lock from handling.meta.
- **License plates** - Any of the game's 13 plate styles and up to 8 characters, drawn with the game's plate textures, font, colours and centring from your GTA V files.
- **Meta simulation** - The Meta tab reads the resource's vehicle metadata: texture liveries, colour presets, extras, ids, plate, texture dictionary and source files, with one-line checks for common configuration conflicts, including bad siren sequencers and siren bones a setting misses or never drives, that expand to the fix.
- **Photo Mode** - A tab for staging photos with game assets. Put up to 16 objects on one set: any vehicle your GTA V files define (search by model, name or make, or filter by class), a freemode ped with a look, clothes and a pose, game props found by search, or your own `.yft`, `.ydr` and `.ydd` models. Move them with the gizmo or placement sliders. A vehicle's tab opens doors and roofs, turns the wheels, fits mod kit parts, switches extras, liveries and the plate, sets the six paint colours and runs its lights. People take 17 pose presets or any clip from the game's animation dictionaries. In the showroom every object has its own spotlight (up to six lit at once) and a dark room sets up night shots. Save PNGs at 1080p, 1440p, 4K, square, portrait or story size, with a transparent background on the workbench.
- **Prop Studio** - A tab for props. Opens `.ydr`, `.ydd` and `.yft` models with their own textures, found beside the model, through its `.ytyp`, in the game files or in a `.ytd` you add. Textured, Clay, Normals and UV check shading, wireframe, each LOD and drawable, per-material visibility, the GTA origin and axes, and the prop's size. Emissives glow with per-material levels, the lights authored into the model light the prop, and the showroom scales to it. Includes a turntable, live reload and transparent PNG export from 128 to 2048 pixels.
- **EUP Studio** - A tab that dresses the male and female freemode peds with your clothing pack without launching the game.
  - **Clothing** - Drawables, texture variants and props from your pack, plus any number of addon `.ydd` pieces named any way, worn one per slot with a matching `.ytd`, PSD or PNG as their texture. Addon packs continue the game's drawable numbers the way a server registers them, so custom hair and clothes are worn by number and several packs load together. Base body numbers match the game's drawable numbers across DLC packs.
  - **Characters** - Two peds on one stage, each with its own ped, pose, skin tone, hair, body and clothing. Body presets set face, skin tone, hairstyle and hair colour together, clothing presets dress the base body in base-game outfits, hair renders in colour, hats flatten the hair under them with the game's own amounts, and a Game props group shows base-game hats, glasses, earrings, watches and bracelets.
  - **Poses** - Idle, Walk, Hands on belt, Arms crossed, Hands clasped or the A-pose from your game files, or **Custom**: any clip from the game's animation dictionaries or your own `.ycd`. Up to four held props hang from the ped's bones with FiveM bone IDs and `AttachEntityToEntity`-style offsets, and **Paste an emote line** sets a clip and its props from an emote menu entry, a `TaskPlayAnim` call or an `AttachEntityToEntity` call.
  - **Import characters** - **Import character…** dresses the ped as a saved vMenu character (clothing, props, closest face, skin tone and hair colour), read without changing FiveM's saves. A vMenu Enhanced transfer code or a character's JSON can be pasted instead, and Menyoo outfit and Spooner `.xml` files open too. Clothing from server-only packs, tattoos, makeup and face sliders are listed rather than guessed.
  - **Workflow** - Live reload swaps a drawable or texture dictionary when it is saved. Each slot shows triangle, vertex, texture size, format, mip and file-size details with streaming warnings, and slots can be hidden or soloed. Arrow keys step through drawables and variants, and named outfits copy as `SetPedComponentVariation`/`SetPedPropIndex` Lua. Checks report real texture dictionary sizes for the 16 MB limit and skipped texture variant letters.
  - **Exports** - Shot packs of up to six angles as PNGs at 4:5, 1:1, 16:9 or 9:16, turntable or fixed-camera videos of 4 to 12 seconds as MP4 or WebM, colourway sheets of every texture of a worn drawable, and batch thumbnails of every drawable as transparent PNGs.
- **Template Generator overlays and mark** - Templates can carry a vehicle overlay (every paintable panel as a solid shape at least 5 px past its edges, on a `_VEHICLE_OVERLAY` layer and as a `<model>_vehicle_overlay.png`) and the Cortex Studio mark on its own layer, placed where it never covers a UV island. Turn the mark off under Output.
- **Studio defaults** - Settings > Studio sets what new work starts with: Workbench or Showroom, spotlight, reflections, beam, floor, rim light and dark room (separately for vehicles, EUP Studio and Prop Studio), light intensity and direction, license plate, and front wheel angle.
- **Ambient occlusion** - Optional soft shading in creases, panel gaps and wheel wells, on the model only, toggled from the view deck in Livery, All and Multi or set as the default in Settings > Viewer. It appears in captures.
- **Showroom floors** - Marble, Checker, Epoxy, Asphalt, Wood and Tread plate join Concrete, Polished and Tiles, with a floor picker in every workspace's Scene tab.
- **Resizable panels** - Drag the inner edge of a dock or inspector in every workspace to resize it, or focus the edge and use the arrow keys; double-click returns it to the default width. Each workspace remembers its widths.
- **Turntable** - The Scene tab in Livery, All, Sirens and Multi spins the vehicle in place under the lights, at 2-90°/s. Turned off, the vehicle settles back facing forward, and captures from a named shot always show it at rest. In Multi, every vehicle spins in its own bay.
- **Delete several projects at once** - **Select** in the Home project list ticks projects instead of opening them. **Select all** takes every project the current filter and search show, and one confirmation (listing the names) deletes the ticked set. Right-click a row and choose **Select** to start from it; **Delete** deletes the ticked projects and **Esc** leaves select mode. Files on disk are never touched.
- **Rotate vehicles in Multi** - **Rotate** on the viewfinder deck swaps the move gizmo for a rotate ring on the selected vehicle. Clicking the lit Move or Rotate button hides the gizmo, and these buttons stay on the deck even when camera controls are set to live in the panel. Each vehicle keeps its facing with the project and in copies.
- **EUP outfit generator** - The Body tab in EUP Studio generates base-game outfits for the male and female ped, replacing the clothing presets. Seven everyday styles mix tops, bottoms, shoes and accessories the game pairs correctly, and twelve service styles (LSPD patrol, Sheriff, Highway Patrol, Park Ranger, SWAT, Corrections, Detective, FIB agent, Security, Military, Coast Guard, Pilot) build on the game's own uniforms. Pressing a style again gives another outfit, and only clothing in your install is used.

### Changed

- **Studio 5 look** - A new Cortex theme (paper, ink and the logo blue) is the default, with condensed display type shared with the Cortex scripts, keycaps for shortcuts and a new app icon. The frame's logo is the Home tab, and tabs are quiet text with an accent underline, an icon for the workspace kind, the full name on hover and F2 to rename.
- **Home** - Workspaces are grouped by job with their real shortcuts. The selected project reads like a template sheet: its name in large caps and a strip of the files it holds in pipeline order. Search and sort sit beside the Projects title, and the version in the status bar opens the changelog. What's New, shortcuts and feedback moved to Settings > About and the toolbar.
- **Workspaces rebuilt** - Livery, All, Multi, EUP, EUP Studio, Variant Builder and Template Generator share one layout: a numbered pipeline on the left, the viewfinder with its camera deck in the middle, and an inspector on the right. Livery images can be dropped straight onto the viewfinder.
- **Showroom** - A new stage for photos: a dark studio, a satin concrete floor with soft reflections, an aimable spotlight with an optional beam, a rim light, contact shadows and studio reflections on the paint. The workbench grid fades out and shadows cover the whole floor. Captures use the stage, and "Save this view" exports exactly what the viewfinder shows.
- **Paint slots** - Vehicle paint follows GTA's paint system: Primary, Secondary, Pearlescent, Wheels, Interior trim and Dashboard, each mesh taking the colour its shader names. Colours come from the game's carcols palette with real finishes (metallic, matte, util, worn, brushed, chrome, gold), or any hex with a finish. Meta colour presets apply all six colours, and saved paint carries over. The Lightbar and accent and Glass tint slots are gone.
- **Multi** - Now a vehicle lineup: up to six vehicles in one scene, each with its own model, livery, window design and paint. Click a vehicle to select it and move it with the gizmo, line them up, put one livery or paint on all of them, and light each one in the showroom. Clothing comparison moved to EUP Studio's addon pieces.
- **Variant Builder** - Export reports what was written and stops when variants would overwrite each other's PNG. Layers have search and All, Visible and Changed filters. The per-layer blend, opacity and lock controls, the turntable button and the Save button were removed because they never changed the export.
- **Template markers** - Markers are drawn by hand: turn on **Draw markers** and drag a box over the pieces to mark, then move, resize, nudge or delete it. Boxes are numbered, saved with the workspace and flagged when they cover no paint geometry. Automatic small-piece detection and the Marker Pick Modifier setting are gone. The template preview zooms around the cursor up to 800% and pans in every direction.
- **Menus** - Right-click menus and dropdowns have 30 px rows, section labels and keycap shortcuts, and dropdowns open directly under their field at every UI scale.
- **First-run setup** - Asks where to start and how Studio should look, applying each choice as you make it, and keeps its Start and Skip actions on screen at the smallest window size.
- **Settings** - A centred layout that pairs sections on wide windows, with new options for project order, delete confirmation, reduced motion, keycaps, automatic update checks, showing the changelog after updates and attaching console logs to bug reports. Settings reports when it could not save.
- **Watermarks** - Text, an imported logo (PNG, WebP, SVG, JPEG) or both, from design presets, with plain, shadow, outline or plate finishes, anchored to any edge or corner or tiled. Sizes scale with the capture, and earlier watermarks keep their look.
- **What's New and feedback** - What's New is a timeline of every release with filters, search and Markdown copy. The feedback dialog picks the type and workflow, shows exactly what is sent, keeps drafts, and offers Copy as Markdown when a build can't send.
- **Game textures** - Showing a model's own GTA textures in All is no longer experimental.
- **Performance** - Opening a `.yft` no longer freezes the window, the CodeWalker bridge stays running between loads, the model cache is capped and cleaned, heavy decodes run off the main thread, idle tabs stop re-rendering, and the showroom reflection is drawn once per frame. Workbench zoom stops at four times the fitted distance.
- **Startup** - A new intro assembles the logo, and tabs and models use lighter loaders.
- **Multi loads whole vehicles** - In the desktop app, Multi reads a `.yft` through the CodeWalker bridge, as All does, so vehicles show their wheels and their own game textures tinted by their paint. Only the active LOD shows and extras start off. Vehicles load one at a time in lineup order, each with its textures, so a full lineup stays responsive while it fills. If the bridge can't read a model, the Model step says the vehicle is showing its shape only.
- **Showroom spotlights hang higher** - The showroom lights and the tops of their beams stay above the frame. In a Multi lineup, every vehicle's light hangs at the height of the whole lineup instead of its own.

### Fixed

- **Template PSDs** - Generated PSDs include their flattened image, so apps that read it no longer show solid black.
- **Template auto-save** - Auto-save only replaces template files it wrote and that have not changed since. An edited PSD with the same name is left alone with a notice, and a save that stops partway says which files were written.
- **Paint after saving settings** - Saving a setting no longer resets the open vehicle's paint.
- **Game textures** - Tyres, brakes and plastic trim no longer turn blue or purple. Shared textures, textures with a shortened mip chain, and 16-bit, 24-bit, alpha-only and other uncompressed formats now load, 32-bit textures keep their channel order, and failures list the textures and the reason.
- **Home projects** - Projects move to the top when you switch to their tab, times show when each was last opened, and projects past the twelfth stay on the list.
- **File checks** - Saved preview folders and restored workspace files are no longer reported missing when they exist.
- **Drop errors** - Livery says why a dropped file couldn't be loaded.
- **Resource access** - Metadata scans and opening source files work for models on other drives, and selected EUP folders can scan their nested asset folders.
- **Capture** - Adjusting framing or capturing angles no longer moves the viewfinder camera.
- **Saved EUP outfits stay saved** - Outfits saved in EUP Studio no longer vanish when you open another session. They are kept for the app and listed in every session, outfits saved in earlier sessions are gathered on first launch, and pack clothing is matched by its file so an outfit still finds it after the pack reloads. A save that fails now says so.
- **Siren spill on the body** - Spill from flashing sirens no longer leaves a pinpoint reflection that jumps around glossy panels, and coronas sit on the light heads instead of the siren bone.
- **Headlights light the right lens** - Where a model splits one headlight into lit and unlit pieces with the same name, turning headlights on no longer makes the unlit trim glow (often orange-red) while the real lens stays dark. Lit headlights, tail lights and indicators now burn at their texture colour instead of fading with the lens texture's transparency.
- **Multi lineup panel** - A long model path no longer pushes the selected vehicle's steps and buttons past the edge of the panel.
- **Livery orientation on bridge models** - Liveries and generated templates no longer land upside down in UV space on vehicles loaded through the CodeWalker bridge (Livery, All Textures, window designs, Variant Builder and Multi).
- **Ground grid** - The Ground grid toggle in the viewer toolbar shows and hides the grid again.
- **EUP wrist props** - Watches and other wrist props in EUP Studio sit on the wrist again instead of on the back of the hand.
- **Showroom floor shimmer** - The showroom floor no longer shimmers with a crawling dot pattern while a vehicle turns with its sirens or lamps lit. Reflections of bright lights are now smooth.

---

## [4.1.0] - 2026-08-12 - PRISM

PRISM cleans up the whole Studio and makes templates, previews, updates, and feedback easier to use.

### Added
- **Themes** - Added 12 color presets with separate System, Light, and Dark choices
- **EUP templates** - Template Generator now supports `.ydd` files and exports each drawable separately when needed
- **Native materials** - Added an experimental way to load materials from game textures while keeping manual textures as the final choice
- **Feature requests** - Feedback now supports feature requests as well as bug reports

### Changed
- **Template Generator** - Rebuilt the workspace with Model, Template, and Split views, better marker tools, zoom controls, model rotation, and a free camera
- **Studio layout** - Cleaned up Home, first-time setup, Settings, viewer sidebars, tabs, and the toolbar
- **Lighting** - Made lighting smaller and easier to adjust with dragging, presets, keyboard controls, and sliders
- **Template handling** - YFT and YDD files now keep their real format so UVs, materials, and mesh selection work correctly
- **Updates** - Updates now download in the toolbar and install when you restart the app
- **What's New** - Rebuilt the release notes with simple filters and better keyboard support
- **Right-click and tooltips** - Added a global right-click menu and Studio tooltips that follow the current theme

### Fixed
- **UI fixes** - Fixed theme colors, active tab seams, interface scaling, high-DPI framing, and context menu positioning
- **Preview export** - Open Folder now works reliably and shows an error when it fails

---

## [4.0.0] - 2026-07-02 - ROAN

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
- **Template Generator manual marker selection** - Pick individual markers with Alt/Ctrl/Shift + click in "Marker Edit Mode". Selections stay staged until you confirm

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
