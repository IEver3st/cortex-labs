# Cortex Studio design language

> Paper and ink. One accent. Condensed caps for identity, plain type for work, and selection that flips to the opposite ink.

Cortex Studio 5 shares one brand grammar with the Cortex FiveM scripts: paper and ink surfaces, a single accent, condensed italic display caps, keycaps for shortcuts, and selection rendered as inverted ink. Studio keeps the desktop necessities the in-game rules forbid: hairline structure, visible keyboard focus, dense inspectors, and resizable layouts.

The product is a production workbench for livery and clothing artists. The user's model, texture, and output are the subject. The interface is a quiet, confident frame around that work. It should never read as a SaaS dashboard, a gaming HUD, a marketing page, or a terminal costume.

## Authority

The rendered **Home**, **Livery**, and **Settings** surfaces define this language. When older CSS, a stock primitive, a legacy block in `src/index.css`, or a previous version of this document conflicts with them, follow these surfaces and the rules below.

| Source | Establishes |
| --- | --- |
| [`src/studio.css`](src/studio.css) | Shared primitives and tokens: `--cx-*` roles, `.cx-display`, `.cx-label`, `.cx-keycap`, `.cx-btn`, `.cx-icon-btn`, the switch, and dialog actions. |
| [`src/lib/theme.js`](src/lib/theme.js) | The `--mg-*` palette for every theme preset in light and dark. |
| [`src/components/HomePage.jsx`](src/components/HomePage.jsx) + [`HomePage.css`](src/components/HomePage.css) | Start rail, focus slate (crop marks, display-caps name, file strip in pipeline order), project rows, filters, search, sort menu, status bar, modal. |
| [`src/components/workspace/`](src/components/workspace/) | The viewer workspace family (Livery, All, Multi): dock, numbered asset pipeline, viewfinder slips, camera deck, inspector tabs and groups. `parts.jsx` is the shared building-block layer. |
| [`src/components/SettingsMenu.jsx`](src/components/SettingsMenu.jsx) + [`SettingsMenu.css`](src/components/SettingsMenu.css) | Section rail, display-caps page title, label-left / control-right rows, callouts, segmented controls, save state. |
| [`src/Shell.jsx`](src/Shell.jsx) + [`Shell.css`](src/Shell.css) | The 36px frame: tabs, context slot, frame actions, window controls. |
| [`src/components/ui/keycaps.jsx`](src/components/ui/keycaps.jsx), [`toggle.jsx`](src/components/ui/toggle.jsx) | Keycap rendering from stored hotkeys; the shared switch. |

`src/index.css` still holds legacy page styles. Its declarations are not precedent. New surfaces get their own stylesheet (see [Code organisation](#code-organisation)).

## Decision order

Clarity, orientation, hierarchy, asset truth, robustness, polish, distinctiveness, decoration. A distinctive treatment that weakens the edit, preview, export loop does not ship.

- Each surface has one leading task. Keep selection, readiness, save, and export state legible at all times.
- Show real assets and real output. Never fake a model, a preview, a terminal, or a successful export for appearance.
- Every control changes real state. Remove a control rather than ship one that does nothing.
- Containment must represent a real boundary: a file, a slip over the scene, a menu, a dialog.

## Signature

Three moves make a surface recognisably Cortex with the logo covered. Use them consistently and nowhere else.

1. **Opposite ink.** The selected row, active nav item, active segment, chosen chip, or chosen option flips to `--cx-invert-bg` / `--cx-invert-fg`. Not an accent wash, not a tinted fill. Secondary text inside it uses `--cx-invert-muted`.
2. **Display caps for identity and figures.** `.cx-display` (Barlow Condensed, italic, 800, uppercase, tabular) names the thing you are working on: the brand, a page title, the focused project, the loaded model, a pipeline step number, an axis label, a keycap. It never sets body copy, labels, buttons, or descriptions.
3. **Keycaps.** Shortcuts render as `.cx-keycap` from the stored hotkey via `<Keycaps>`. They stay outlined and quiet until their row is hovered, focused, or armed, then light up in opposite ink.

The numbered asset pipeline (step disc, connecting hairline, dashed drop target, file card) is the workspace-level expression of the same grammar: work moves top to bottom, and a finished step fills with the accent.

## Colour

### Palette tokens

All product colour comes from `--mg-*` (theme preset) and `--cx-*` (roles derived in `studio.css`). Never hard-code a theme colour in a component. Every surface must work in every preset in both light and dark.

| Role | Token | Cortex light | Cortex dark | Use |
| --- | --- | --- | --- | --- |
| Paper | `--mg-bg` | `#f0f0e9` | `#121316` | Workspace canvas, main columns. |
| Surface | `--mg-surface` | `#e5e5dc` | `#1b1d21` | Structural fills where a step is needed. |
| Ink | `--mg-fg` | `#0f1012` | `#f0f0e9` | Primary text and icons that lead. |
| Muted ink | `--mg-muted` | `#575b61` | `#a2a6ad` | Descriptions, metadata, idle icons, labels. |
| Hairline | `--mg-border` | `#d2d2c7` | `#2c2f35` | Structural dividers, control outlines. |
| Field | `--mg-input-bg` | `#fafaf6` | `#17191c` | Inputs, file cards, segmented tracks. |
| Accent | `--mg-primary` | `#3462bd` | `#558bf6` | Primary action, focus, active indicator, progress, done steps. |
| Destructive | `--mg-destructive` | `#b94842` | `#dc7c72` | Destructive actions and real errors only. |

Derived roles in `studio.css`:

| Token | Meaning |
| --- | --- |
| `--cx-invert-bg`, `--cx-invert-fg`, `--cx-invert-muted` | Opposite ink for selection. |
| `--cx-wash`, `--cx-wash-strong` | Hover and pressed tints (5% and 9% ink). |
| `--cx-frame` | Frame and status-bar fill. Rails use `color-mix(in srgb, var(--mg-bg) 55%, var(--cx-frame))`. |
| `--cx-raised` | Menus, popovers, dialogs. Pair with `--cx-shadow-pop`. |
| `--cx-rule` | Softer hairline between rows inside a section. |
| `--cx-focus` | Two-ring focus: paper gap then accent. |
| `--cx-on-primary` | Text on a filled accent. |
| `--cx-caution`, `--cx-confirm` | Warning/pending and success/live. They never follow the accent. |
| `--cx-cat-*` | Project categories: livery, all, eup, multi, siren, variant, template, prop. |

### Accent discipline

The accent is the only saturated hue on an ordinary screen. Appropriate: the primary action, focus rings, the active tab or filter underline, a rail item's hover bar, a done pipeline step, slider fill, progress, the brand mark. A region usually has one leading accent cue. Selection is ink, not accent.

### Status and category

- Caution, confirm, and destructive carry meaning only: a warning, a live or completed state, an error. A dot, an icon, or a tinted callout (`9-12%` mix with a `40-50%` border) is enough.
- Category hue appears once: the Home rail icon, a 7px square marker before a tag (`.hp-tag`), or a 2px hover bar. Never fill a row, tile, or icon box with it, and never use it as a status.
- Viewport axis colours (`--lv-axis-x/y/z`) label rotation controls only.

## Typography

Three families, defined in `src/index.css` and bundled in `src/fonts.css`:

- `--font-display`: Barlow Condensed. Only through `.cx-display` or an explicit `italic 800` shorthand for figures.
- `--font-main`: Segoe UI Variable Text. All interface text.
- `--font-hud`: Consolas / Cascadia Mono. Paths, file folders, hex values, counts, dimensions, times, version strings.

| Role | Treatment | Reference |
| --- | --- | --- |
| Page identity | `.cx-display`, `26-40px` | Settings rail title `26px`, Settings page title `40px`, modal title `28px`. |
| Focus identity | `.cx-display`, `clamp(30px, 3.6vw, 50px)`, two-line clamp | Home focused project. |
| Section title | Main, `14-15px`, `650` | "Start a session", pipeline step title, project list title. |
| Structural label | `.cx-label`: `10.5px`, `700`, `0.14em`, uppercase, muted | Rail groups, inspector groups, fact keys, field labels. No `//` prefixes or brackets. |
| Primary label | Main, `13-13.5px`, `600` | Rows, nav items, file names. |
| Body / description | Main, `12-12.5px`, muted, `1.35-1.55` line height | One line under a row; hints in drop targets. |
| Metadata | Mono, `11-12.5px`, muted, tabular | Paths, sizes, times, counts. |
| Keycap | Display italic `11-12px` inside `.cx-keycap` | Shortcuts. |

Sentence case for everything except `.cx-display` and `.cx-label`. Truncate metadata before the primary label; long names get a `title` with the full value.

## Units and scaling

UI Scaling sets `--u`. Size type, spacing, and control geometry as `calc(N * var(--u))` so the user's scale applies, as Home, Settings, and `studio.css` do. Hairlines stay `1px`. Workspace chrome that sits on the 3D scene may use fixed pixels when it must match the viewer.

## Layout topology

Desktop-first. Structural columns are bounded with `clamp()`; the working column is `minmax(0, 1fr)` and owns its own scroll.

| Surface type | Columns | Reference |
| --- | --- | --- |
| Launcher / settings | Rail `clamp(220-250px, 22-24vw, 272-310px)` + main | Home, Settings |
| Viewer workspace | Dock `clamp(250px, 21vw, 300px)` + stage + inspector `clamp(280px, 23vw, 330px)` | Livery, All, Multi |

- Rails and docks use the rail fill and a hairline on their inner edge. The main column sits on paper.
- Rails scroll independently; utilities pin to the bottom behind a hairline.
- The page has no outer padding frame, no floating islands, and no rounded panels around regions. Regions meet at hairlines.
- Status bars are `28px`, `--cx-frame`, mono counts left, hairline-separated meta right.
- A workspace can drop to focus mode (stage only) and close its inspector. Collapse columns to `0` in the grid; keep their state.

## State grammar

| State | Treatment |
| --- | --- |
| Rest | Transparent. Muted icon and secondary text. |
| Hover | `--cx-wash`. Rail items also grow a 2px accent (or category) bar at the left edge via `scaleY`. Nothing moves. |
| Pressed | `--cx-wash-strong`. |
| Selected / active | Opposite ink. Inner muted text uses `--cx-invert-muted`; inner icon buttons hover with `10%` invert-fg. |
| Focus-visible | `box-shadow: var(--cx-focus)` on free-standing controls; `inset 0 0 0 2px var(--mg-primary)` on full-bleed rows. Never `outline: none` without a replacement. |
| Disabled | `opacity: 0.4-0.45`, `cursor: not-allowed`, real `disabled` attribute, and a reason nearby when the reason is not obvious. |
| Armed | A row whose shortcut is live lights its keycaps (`.is-armed`). |

Hover-only row actions also show on `:focus-within` and on the selected row.

## Controls

Use the shared primitives before writing a local one. A local variant should change density, not grammar.

- **Buttons** `.cx-btn`: `32px`, radius `5px`, hairline outline, `12.5px/600`. Variants `.is-primary` (filled accent, one per region), `.is-quiet` (no outline, muted), `.is-danger`. Compact `28px` inside docks and slips. Icons `14px`.
- **Icon buttons** `.cx-icon-btn`: `28px`, borderless, muted, `15px` glyph. Every one has an `aria-label` and a `title`.
- **Switch**: the shared `<Toggle>` (`.settings-toggle`). Accent fill when on. Never a checkbox styled as a switch.
- **Segmented control**: a track on `--mg-input-bg` with a hairline, `3px` padding, `26-28px` segments; the active segment is opposite ink (`.settings-seg`, `.lv-seg`).
- **Tabs and filters**: text buttons with a `2px` accent underline that scales in on the active item (`.lv-tab`, `.hp-filter`). Counts follow in mono.
- **Inputs and selects**: `32px`, `--mg-input-bg`, hairline, radius `5-6px`; focus turns the border accent with a `3px` `22%` accent halo. Hex and numeric fields use mono.
- **Dropdowns**: always `Select` / `SelectTrigger` / `SelectContent` / `SelectItem` from `components/ui/select.jsx`, never a native `<select>` (its OS menu ignores the theme). Adjust width or density with a class on the trigger, not a new menu. Radix items cannot hold `""`, so map an empty choice to a sentinel value. `src/lib/ui-conventions.test.mjs` fails on a native `<select>`.
- **Sliders**: `4px` track filled with the accent to the value, ink thumb with a paper ring; value in mono, right-aligned, tabular.
- **Chips** (choice sets like capture angles): `30px` outlined; chosen chips are opposite ink.
- **Menus and popovers**: `--cx-raised`, hairline, radius `7-8px`, `--cx-shadow-pop`, `30px` items, accent check for the current option.
- **Dialogs**: `--cx-raised`, radius `8px`, display-caps title, `.settings-primary` / `.settings-secondary` footer actions, `rgba(8,9,11,0.6)` scrim.

## Workspace patterns

These come from the viewer workspace family and apply to any surface built around a 3D or 2D canvas.

### Asset pipeline (dock)

- Steps are `AssetSlot`s: a `23px` step disc in display italic, a hairline joining it to the next step, a `14px/650` title, and an optional trailing switch.
- An empty step shows a `DropButton`: dashed `1.5px` muted outline, radius `9px`, accent plus glyph, one-line hint, keycaps. Hover turns the outline accent with a `7%` wash.
- A filled step shows a `FileCard` (name `13px/600`, folder in mono, on `--mg-input-bg`, radius `8px`) with Replace (folder) and Unload (close) as `28px` icon buttons at its right edge. Fact rows about the file follow the card; a row that acts (Saved vehicle) opens in place like a disclosure.
- A finished step fills its disc with the accent and shows a check.
- Status notes under a step use a `7px` dot plus one line: accent (ok), confirm (live), caution (warn), destructive (error), muted (idle).

### Viewfinder and slips

- The stage fills its column. Anything drawn over the scene sits on a **slip** (`.lv-slip`): `--lv-slip` (frame at 90%), a `--lv-slip-line` hairline, a soft `0 6px 18px` shadow, radius `9-11px`, and no backdrop blur (blur re-samples WebGL every frame). The user picks the backdrop colour, so text never sits on the scene directly.
- Layout of slips: stage or view switch top-left (opposite-ink segments), alerts top-centre (caution-tinted, with a dismiss or fix action), toasts top-right, camera deck bottom-centre. The stage carries no title; the tab names the file.
- The camera deck groups shots (`Front`, `Rear`, `Side`, `3/4`, `Top`), framing, and axis rotation; groups split by a slip hairline. Active toggles get a `20%` accent fill. Axis buttons use display italic in axis colours.
- A drop overlay is the only large accent wash: `10%` accent with a `2px` inset accent ring and a display-caps verb.
- Container queries hide the legend and move the deck as the stage narrows.

### Inspector

- Tabs across the top (`InspectorTabs`), then a scroll region of groups separated by `28px`.
- Each group: a `.cx-label` heading, optional trailing count or action, then rows. Rows are dense: a swatch or icon, a label, a value field, a hover-revealed reset.
- Empty inspectors say what to select in one line.

## Page anatomy

- Launcher and settings pages name themselves once in display caps (Home focus name, Settings content title). Workspaces leave the name to the tab and give the space to the asset. Never add a header band, a kicker, or a `// PAGE NAME` eyebrow.
- The frame context slot (`.shell-context`) carries panel toggles and, at most, page-level view switches. Workflow controls live in the page where the user is looking.
- Tool surfaces open on the usable tool. An empty state lives inside the real layout (empty pipeline steps, an empty stage message) rather than replacing the page with a hero.

## Empty, loading, and error states

- Empty: one short title, one line of help, one action. Muted icon at `16-20px` only if it helps recognition. No illustrations, rings, or icon tiles.
- Loading: keep the layout; say what is happening ("Loading model…", "Building template…"). A thin accent progress bar for measurable work.
- Error: name the failed operation and the file or format, use destructive colour for the text or icon only, and offer the recovery action. Partial writes are reported as partial.
- Success after a write: a confirm-coloured check and the destination path in mono, so the user can open it.

## Frame and status

The Shell frame is `36px` on `--cx-frame` with tabs, the context slot, feedback, settings, and window controls. Tauri drag regions stay on spacers; every control is `-webkit-app-region: no-drag`. Page status bars follow the Home footer: `28px`, mono, hairline separators, no badges.

## Motion

- Default `140ms` with `--cx-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`) on named properties. Indicators (underline, hover bar, switch thumb) `160-180ms`. Dialogs and menus `120-180ms`.
- Motion explains a state change: an indicator arriving, a panel opening, a step completing. Nothing loops except a real recording or busy indicator.
- No hover displacement on rows or controls. Small icon nudges on rail items are the only exception.
- `prefers-reduced-motion: reduce` removes transitions and animations while keeping state visible.
- `forced-colors: active` maps selection to `Highlight` outlines and keeps focus visible.

## Responsive behaviour

Choose breakpoints from content. Reference behaviour:

- Home: under `1100px` the focus actions move below the file strip; under `700px` tall the slate tightens and drops file folders; under `900px` the rail narrows to `212px` and drops descriptions and keycaps.
- Settings: sections pair side by side when each can be `460px` wide.
- Workspaces: container queries on the stage hide the legend under `820px` and dock the deck left under `680px`.

At every supported size: no horizontal page overflow, primary controls visible, secondary metadata truncates first, selection and recovery paths survive reflow.

## Code organisation

- Shared primitives and roles live in `src/studio.css`. Promote a pattern there only after two real consumers share its contract.
- Each surface owns a stylesheet next to its component with its own class prefix: `hp-` Home, `settings-` Settings, `lv-` viewer workspaces. New surfaces follow suit and import their CSS from the component. Do not add new page styles to `src/index.css`.
- Viewer-style surfaces should compose `src/components/workspace/parts.jsx` (`AssetSlot`, `FileCard`, `DropButton`, `DeckButton`, `InspectorTabs`, `Slider`, `SelectField`) rather than re-implement them.
- Icons are Lucide, stroke-based, `14-16px` in rows and controls, `15-16px` in deck buttons, `18px` on Home rail modes.
- Use Radix-based `ui/select` and `ContextMenu` for menus that need portals; style them with the raised-surface tokens.

## Avoid

- Accent washes for selection, coloured icon tiles, rainbow categories, or status colours used for variety.
- `// LABEL` eyebrows, bracketed or underscored pseudo-code labels, monospace prose.
- Display caps on buttons, descriptions, or long text; uppercase sentences.
- Cards inside cards, rounded panels around regions, dashboard stat grids, hero empty states.
- Glow, gradients as fills, glassmorphism, backdrop blur over WebGL, scanlines, particles.
- Fake controls: sliders, toggles, or menus not wired to real state.
- Hard-coded theme colours, `transition: all`, hover-only actions with no keyboard path, invisible focus.
- Copying stock shadcn spacing and radii, or inventing a new aesthetic per workflow.

## Review checklist

- One leading task and focal region; display caps used for identity and figures only.
- Selection is opposite ink everywhere on the surface; the accent appears only where it has a job.
- `.cx-label` headings, sentence-case labels, mono metadata; no `//` eyebrows.
- Shared primitives and workspace parts used where they fit; local CSS is scoped to the surface prefix.
- Every control changes real state; disabled controls explain why.
- Empty, loading, error, partial-write, and success states designed and reachable.
- Light and dark in at least two presets; UI scaling via `--u`; reduced motion and forced colours.
- Minimum window width checked: no horizontal overflow, nothing clipped.
- Browser render is not Tauri proof: native dialogs, writes, and watches verified in `bun run tauri dev` when touched.
