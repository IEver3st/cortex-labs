# Cortex Studio visual design language

> A restrained, dense desktop developer workbench with subtle terminal influence.

Cortex Studio should feel like an IDE, asset browser, and professional desktop utility for livery work. It should not feel like a SaaS dashboard, game HUD, marketing page, colourful launcher, or stock component-library demo.

This document defines the shared visual and interaction vocabulary for product UI. It is prescriptive about hierarchy, colour, density, and feedback, but it does not require every workflow to use the same layout. A model viewer, layer inspector, template builder, and Home page may need different structures while still clearly belonging to Cortex Studio.

## Decision standard

Apply this order: task clarity, navigation and context, hierarchy, asset truth, robustness, polish, distinctiveness, decoration. A distinctive treatment that weakens the production workflow does not ship.

Cortex Studio's signature is the neutral IDE-like workbench, scarce orange selection and focus rules, persistent asset context, and the relationship between the model viewer, rows, layers, and inspectors. Product data and authored assets create the visual interest.

- Give each workspace one leading production task while keeping selection, save, validation, and export state legible.
- Use typography, alignment, pane geometry, model imagery, and structural rules before cards or extra chrome.
- Show real assets and outputs. Never manufacture a terminal, model state, or successful export for appearance.
- Containment must represent an actual object or working boundary.
- Motion explains navigation, selection, disclosure, loading, and spatial continuity. Nothing moves continuously for atmosphere.
- If two generic patterns appear together, such as card grids, decorative pills, glow, repeated eyebrow headings, or filler descriptions, stop and subtract.

Before handoff, stress supported desktop sizes, long filenames and paths, empty and large projects, missing textures, parse and export failures, keyboard-only use, zoom, high contrast where practical, and reduced motion. Build and browser output are not Tauri runtime or native-sidecar proof.

## Authority and scope

The rendered Home / Overview workbench is the canonical visual reference. When older UI, an earlier CSS declaration, a stock primitive, or an old comment conflicts with the rendered Home direction, follow Home and the rules in this document.

The canonical Home treatment is the main workbench: Quick Start, Recent Projects, Context, filters and toolbar controls, empty states, and footer status. The later `HOME PAGE — unified desktop workbench` block in [`src/index.css`](src/index.css) intentionally refines earlier Home declarations. Source order and the rendered result matter; do not revive the older “monospace-only,” colourful, card-heavy treatment simply because those declarations remain in the file.

Home is an implementation reference, not a layout template. Its current bounded side regions and fluid project browser demonstrate a principle: structural panels may have deliberate fixed or bounded widths while the primary workspace remains fluid.

## Design principles

1. **Utility before decoration.** Every visual treatment should clarify hierarchy, state, navigation, action, or system feedback.
2. **Neutral by default.** Most surfaces, icons, text, borders, and controls use the neutral theme. Colour is the exception.
3. **Accent with purpose.** Cortex orange identifies brand, active navigation, selection, focus, and genuinely primary actions. Scarcity gives it value.
4. **Density is intentional.** This is a desktop production tool. Compact, readable information is preferable to marketing-page whitespace.
5. **Hierarchy before containers.** Use alignment, type, spacing, and subtle surface shifts before adding a border or another rectangle.
6. **One visual vocabulary.** Features can have workflow-specific arrangements, but their icon scale, type hierarchy, surfaces, feedback, and colour discipline must remain recognizably Cortex.
7. **State is part of the design.** Hover, focus-visible, selected, disabled, loading, empty, error, overflow, and reduced-motion states are not optional finishing work.

## Canonical reference: Home / Overview

Study these sources before creating or materially restyling application UI:

| Source | What it establishes |
| --- | --- |
| [`src/components/HomePage.jsx`](src/components/HomePage.jsx) | Home structure, Quick Start and project rows, filters, search and sort controls, Context inspector, empty states, status footer, and semantic use of icons and category labels. |
| [`src/index.css`](src/index.css) | Global theme variables and typography; the final `HOME PAGE — unified desktop workbench` block contains the canonical Home refinements, row states, dimensions, category tags, focus treatment, and resize behavior. |
| [`src/Shell.jsx`](src/Shell.jsx) | Desktop chrome, tab strip, window controls, and the relationship between application chrome and workspace content. |
| [`src/components/ContextMenu.jsx`](src/components/ContextMenu.jsx) | The shared Radix-based context-menu layer and its desktop interaction boundary. |
| [`src/components/ui/`](src/components/ui/) | The current shadcn/Radix-style primitive layer for buttons, inputs, labels, selects, and toggles. |
| [`tailwind.config.js`](tailwind.config.js) | Tailwind aliases for the Cortex palette, typography, surfaces, borders, and radii. |
| [`src/lib/theme.js`](src/lib/theme.js) | System, light, and dark theme resolution. |
| [`colorpalette.md`](colorpalette.md) | Broader Cortex brand-palette background. For Studio UI behavior, this document and the rendered Home page are more specific. |

On Home, pay particular attention to:

- Quick Start and Recent Projects sharing a quiet row language instead of separate feature cards;
- neutral, borderless icon slots with small Lucide glyphs;
- orange used for the brand, active filter underline, selected-row indicator, focus, and primary action—not decoration;
- category colour appearing only in small project tags;
- the fluid middle workspace separated from bounded structural regions by hairline dividers;
- primary label, secondary description, metadata, shortcut, and category-label type levels;
- Context behaving as a structural inspector rather than a large card;
- concise empty states and compact application status.

Neighboring screens such as [`src/components/VariantsPage.jsx`](src/components/VariantsPage.jsx), [`src/components/TemplateGenerationPage.jsx`](src/components/TemplateGenerationPage.jsx), [`src/components/SettingsMenu.jsx`](src/components/SettingsMenu.jsx), and [`src/App.jsx`](src/App.jsx) provide workflow and interaction context. They are not visual authority where their older or local styling conflicts with Home.

## Colour system

### Core theme

Use semantic variables instead of scattering hex values or theme-specific opacity classes. The core palette is defined in [`src/index.css`](src/index.css) and mapped in [`tailwind.config.js`](tailwind.config.js).

| Role | Token | Light | Dark | Guidance |
| --- | --- | --- | --- | --- |
| App canvas | `--mg-bg` | `#F3F1EC` | `#1F1E1D` | Default full-bleed workspace. |
| Structural surface | `--mg-surface` | `#EAE7E0` | `#33312F` | Chrome, rails, panels, and controls that need separation. |
| Primary text | `--mg-fg` | `#1F1E1D` | `#F3F1EC` | Labels and content that must lead. |
| Secondary text/icons | `--mg-muted` | `#5A554F` | `#B0AAA3` | Descriptions, metadata, inactive icons, and subordinate chrome. |
| Structural line | `--mg-border` | `#DCD7CE` | `#4A4744` | Hairline dividers and meaningful control boundaries. |
| Cortex orange | `--mg-primary` | `#D97952` | `#D97952` | Brand and intentional interaction emphasis. |
| Destructive | `--mg-destructive` | `#C2544A` | `#C2544A` | Destructive actions and critical errors only. |
| Input surface | `--mg-input-bg` | `#FCFAF8` | `#2A2827` | Inputs and controls that require a distinct field surface. |

New UI must work in both light and dark themes. Prefer `color-mix()` or semantic variables for subtle theme-relative states. A hard-coded light or dark foreground is acceptable only when paired with a deliberately fixed surface, such as light text on the orange primary action.

### Cortex orange

Cortex orange is the primary brand and interaction accent. Appropriate uses include:

- active navigation or filter indicators;
- selected-state markers where a marker improves scanning;
- focus treatment;
- primary actions;
- branding;
- meaningful interaction emphasis, progress, or an actual warning/pending state.

Do not scatter orange across ordinary icons, headings, borders, metadata, and backgrounds at the same time. A region should usually have one leading orange cue. Selection should not become a large orange wash.

### Category colour

Home defines subdued, theme-aware category colours with page-scoped `--hp-tag-*` variables for Livery, All, EUP, Multi, Variant, and Template. The important pattern is not the exact hex value; it is the narrow semantic role:

- feature and project icons remain neutral;
- a small category label may carry the category hue;
- the row background, icon, border, and tag do not all repeat that hue;
- category colour never replaces selection, focus, warning, error, or disabled semantics.

If another screen needs category recognition, use one small marker—usually text, a dot, or a narrow indicator. Do not create rainbow icon tiles. Do not promote Home's page-scoped tag variables into a global API without first deciding that the categories and contrast requirements are truly shared.

### Semantic status colour

Success, warning, error, and informational colours are reserved for states that carry those meanings. Do not use them for variety or feature branding.

The repository does not yet have one complete, consistent global success/warning/info token set. Reuse an established workflow-owned semantic token when its meaning matches, or introduce a deliberately named token at the narrowest shared scope. Never repurpose a category hue as a status colour. Destructive and critical-error treatment uses `--mg-destructive`; orange remains the primary interaction accent and may represent warning or pending only when the state is genuinely warning or pending.

## Typography

Studio uses two families:

- **Syne** via `--font-main` for primary application text, page identity, labels, and readable descriptions.
- **DM Mono** via `--font-hud` for structural labels, shortcuts, file/path metadata, status, compact technical values, and restrained terminal cues.

The system should feel technical without becoming a terminal parody. Use family, weight, size, spacing, and alignment before adding colour.

| Level | Home reference | Use |
| --- | --- | --- |
| Application identity | About `15px`, semibold, tracked uppercase | Product or major workspace identity. Use sparingly. |
| Structural heading | About `10px`, semibold, tracked | `// QUICK START`, `// RECENT`, `// CONTEXT`, time groups, and compact panel headings. |
| Primary content label | About `11–13px`, medium | Project names, mode names, selected-object identity. |
| Secondary description | About `9–10px` | One-line supporting explanation. |
| Metadata/status | About `8–9px`, often mono | Paths, times, counts, status-bar data, field labels, and compact technical values. |
| Category label | About `8px`, compact and tracked | Small semantic classification, not a headline. |
| Keyboard hint | About `8px`, mono and quiet | Trailing shortcuts such as `Alt+1`; usually not a decorative keycap. |

These are reference measurements, not universal minimums. Preserve the hierarchy and account for the application UI scale, content length, contrast, and reading context.

Pseudo-code labels such as `// QUICK START` are appropriate for structural landmarks. Underscores, brackets, command prompts, all-caps tracking, monospace, and orange should not all be applied to the same content by default. Ordinary prose, actions, and object names should read naturally.

## Iconography

Use **Lucide** for new product UI. It is the dominant library across Home, Shell, viewers, settings, Variant Builder, and Template Generator. `react-icons/ri` is currently a narrow What's New exception, not permission to mix icon families in new work.

Home demonstrates the preferred scale:

- ordinary row glyphs are typically `16px` inside a `20px` alignment slot;
- toolbar, metadata, and trailing-action glyphs are commonly `12–14px`;
- empty-state glyphs remain small, generally around `16–20px`;
- Shell chrome can be smaller, around `11–13px`, because it is persistent secondary chrome.

Icon slots are alignment devices, not decorative containers. By default they are transparent, borderless, square, and neutral. Increase contrast on hover, focus, active, or selected states. Use orange only when the interaction semantics warrant it.

Avoid coloured rounded-square icon containers, rainbow feature icons, a tinted background behind every glyph, oversized icons, mixed stroke languages, glows, and icon-only controls without accessible names or discoverable labels.

## Surfaces, hierarchy, and containers

Home's coherence comes from hierarchy rather than cardification. Quick Start, Recent Projects, and Context are regions separated by alignment, spacing, and hairline dividers. Their content does not float inside nested cards.

Use this order of operations:

1. establish hierarchy with layout, alignment, type, and spacing;
2. add a subtle background change for hover, selection, or a distinct workspace region;
3. add a border only when it communicates structure, grouping, input affordance, or another layer;
4. use elevation only for overlays or content that genuinely sits above the workspace.

Prefer rows for repeated, scan-oriented content. Use a card only when an item is independently movable, previewable, or conceptually self-contained enough to require a boundary. Do not put a card inside a card to express text hierarchy.

Persistent panels may use structural dividers. Popovers, menus, and dialogs may use a stronger surface and border because they occupy another layer. Shadows are optional there and should remain tight and quiet; main workspace surfaces should generally have none.

The faint masked grid on Home is a rare, low-contrast background texture. It does not justify decorative patterns on every screen. The scanline treatment is explicitly hidden by the canonical Home refinement.

## Rows and list interfaces

Quick Start and Recent Projects share `hp-workbench-row`, which establishes a reusable interaction language even though it is currently page-local rather than a shared React component.

| State | Treatment |
| --- | --- |
| Default | Transparent or base-surface background; neutral icon and secondary copy; no unnecessary outline. |
| Hover | Subtle neutral surface change. Increase icon and trailing affordance contrast without moving the row. |
| Selected | Slightly stronger neutral surface plus a restrained orange indicator when useful. Do not flood the row with category colour. |
| Focus-visible | Clear keyboard outline; Home uses a `2px` orange/foreground mix with a small offset. Focus must remain visible in both themes. |
| Disabled | Preserve legibility, reduce emphasis, suppress unavailable actions, and expose the disabled state semantically. Do not rely on low contrast alone. |

A typical row may contain:

1. a small neutral icon or state marker;
2. a primary label;
3. one concise secondary line;
4. metadata or a small category label;
5. trailing time, status, or actions.

Keep columns aligned across rows and reserve space for variable text and trailing actions. Truncate secondary metadata before obscuring the primary label. Hover-only actions must also appear on `focus-within`; on coarse pointers they should remain visible. Selection and activation are separate concepts where the workflow needs both, as Home uses single-click selection and double-click or Enter to open.

The current Home composition is real code, not a proposed API:

```jsx
className={`hp-workbench-row hp-project-row ${
  isSelected ? "is-selected" : ""
}`}
```

Reuse its state model or extract it intentionally if multiple screens need it. Do not invent and advertise a `StudioRow` API until such a shared component actually exists.

## Spacing and density

Whitespace establishes relationships; it is not a goal by itself. Cortex should make productive use of a desktop viewport.

- Keep related labels, controls, and metadata close.
- Use compact rows and control bars, with larger gaps only between distinct structural regions.
- Prefer horizontal use of wide space when it improves comparison or keeps the primary workspace visible.
- Use consistent local rhythm: very small gaps for items within a row, medium gaps within a section, and larger spacing at region boundaries.
- Avoid hero-scale headers, oversized padding, giant vertical gaps, and empty columns that exist only to make the page look minimal.

Reference measurements from Home—not global mandates—include `48–50px` launch/project rows, `30px` search/filter controls, mostly `6–10px` internal row gaps, `16–20px` region padding, and compact status chrome. Its `23px` trailing row action buttons with `12px` icons are a dense in-row exception, not a universal target-size minimum.

## Radius, borders, and shadows

- **Radius:** small and controlled. The global `--mg-radius` is `6px`; Home commonly refines rows and controls to `4px` and menus to about `5px`. Use the shape appropriate to the layer without drifting into large SaaS rounding.
- **Borders:** quiet `1px` structural lines. A border should explain a panel boundary, input, group, selection, or layer—not outline every child.
- **Shadows:** rare. Home's main workbench uses none. Menus, popovers, dialogs, and transient notices may use modest elevation when a border and surface alone are insufficient.
- **Pills:** reserve fully rounded shapes for compact statuses, counts, toggles, or values whose shape has meaning. Ordinary buttons, tabs, and containers should not all become pills.

## Controls and toolbars

Buttons, search inputs, selects, toolbar actions, toggles, and shortcut hints should feel like one desktop control family.

Controls in the same context should share:

- height and vertical alignment;
- icon scale;
- restrained radius;
- typography and label casing;
- neutral border/background behavior;
- hover, focus-visible, active, and disabled treatment.

Home's search and sort controls are `30px` high with `4px` radii, small icons, compact text, subtle neutral surfaces, and orange only in focus/active treatment. Filters use an orange underline instead of filled pills. Secondary toolbar controls remain quieter than the content they operate on.

Primary actions may use a solid orange fill with a fixed high-contrast foreground. Most actions should be neutral, outline, or ghost treatments. Destructive red appears on destructive action or hover—not on unrelated controls. Do not use oversized CTA styling for routine desktop actions.

Keyboard hints should be compact, right-aligned where useful, and visually subordinate. A plain mono hint is usually preferable to a box around every shortcut.

Toggles must communicate both current value and interactivity. Use a compact track/thumb or an established segmented treatment, preserve a visible focus state, and do not use success colour merely because a setting is on.

## Panels and inspectors

Inspectors are structural workspace regions, not giant cards. The Home Context region demonstrates the expected hierarchy:

- a quiet structural heading;
- selected-object identity with a small neutral icon and optional category label;
- dense label/value fields;
- subtle separators between summary, fields, and actions;
- primary action at the natural edge of the workflow;
- a minimal empty state when nothing is selected.

Inspectors should normally be quieter than the main workspace. Give them stronger emphasis only for errors, required decisions, or a deliberate focused-editing mode. Use bounded widths for stable tools and leave the main canvas or list fluid. If a panel can collapse or move at narrower widths, preserve selection and context while it does so.

An empty inspector should not contain a second dashboard, tutorial, illustration, or promotional panel. Say what must be selected and, only when useful, how to do it.

## Empty, loading, and error states

Ordinary empty states should have low visual weight:

- one concise title;
- one short explanation;
- a small neutral icon only when it improves recognition;
- one relevant next action, with secondary actions only when genuinely useful.

Home's empty Recent area uses a small terminal icon, short copy, and compact actions; its empty Context uses a small information icon and two brief lines. These states do not need coloured icon boxes, illustrations, huge cards, or long onboarding prose.

Loading states should preserve the surrounding layout and indicate what is happening. Errors should identify the failed operation, use destructive colour only for a real error, and provide a recovery action when possible. Avoid replacing a dense workspace with a dramatic full-page state for ordinary no-selection, no-results, or hidden-content conditions.

## Desktop chrome and status bars

Application chrome should resemble IDE and native-tool chrome, not website navigation or a footer. [`src/Shell.jsx`](src/Shell.jsx) demonstrates a compact `36px` unified toolbar with tabs, context actions, and window controls.

- Keep persistent chrome compact, stable, and lower-emphasis than workspace content.
- Use neutral icons and surfaces; orange may identify the active tab or meaningful active state.
- Align status text, counts, and separators consistently.
- Use tabular numerals for changing counts or time values when alignment matters.
- Protect Tauri drag regions: interactive controls must remain explicitly non-draggable.
- Do not turn the status bar into a collection of badges or a website footer.

Home's footer status is a useful model: short mono status, compact project counts, hairline separators, and a quiet shortcut hint.

## Motion

Motion explains state, continuity, or layer changes. It is not decoration.

Home's canonical row and control feedback is roughly `120–140ms` with explicit colour/opacity properties. Its sort menu opens in about `120ms`; the New Project modal uses about `180ms`. These are useful reference ranges for frequent desktop interactions. The slower first-empty-state entrance is an occasional introduction, not a default for every region.

- Prefer short, interruptible opacity, colour, and small transform transitions.
- Do not move rows or controls on hover.
- Use overlay entrance/exit motion to clarify layering and origin.
- Avoid `transition: all`; name the properties that change.
- Avoid bounce, large scale changes, animated gradients, perpetual decoration, and staggered entrances for routine content.
- Respect `prefers-reduced-motion`. Home reduces transition duration to effectively immediate while preserving state meaning.

## Responsive desktop behavior

Cortex Studio is desktop-first, not mobile-first, but resize behavior is product behavior. Do not build for one screenshot-perfect viewport.

Layouts should:

- work at expected desktop dimensions and the supported minimum window size;
- protect the primary workspace with `minmax(0, 1fr)`, deliberate overflow, and bounded secondary regions;
- reflow before content collides or creates accidental horizontal scrolling;
- move, collapse, or constrain secondary information before sacrificing the primary task;
- preserve selection, controls, and recovery paths after reflow;
- shorten or hide truly secondary metadata only when necessary.

Home demonstrates the policy rather than prescribing global breakpoints: near `1120px` its Context inspector moves below the main columns; near `820px` project header controls reflow; near `740px` regions stack and the page scrolls; near `520px` secondary time/footer information is reduced. New screens should choose breakpoints from their content, using the same deliberate degradation.

## shadcn/ui and shared primitives

The components in [`src/components/ui/`](src/components/ui/) use shadcn/Radix composition patterns. They are an implementation foundation, not Cortex Studio's design language.

- Reuse or compose an existing primitive when it cleanly supports the interaction.
- Apply semantic Cortex tokens and local composition so the result matches Home.
- Do not copy stock shadcn examples verbatim or let their default spacing, rounding, cards, and typography dictate the product.
- Do not create a bespoke input, select, button, or toggle merely to avoid adapting an existing primitive.
- Do not globally restyle a shared primitive without auditing every consumer; several current primitives still contain hard-coded dark/white defaults and rely on caller overrides.
- Prefer a scoped variant or composed component when only one workflow needs a different density or surface.
- Do not force an existing primitive onto an interaction it cannot represent accessibly or clearly.

[`src/components/ContextMenu.jsx`](src/components/ContextMenu.jsx) is similarly a shared behavior layer: preserve its Radix semantics and portal positioning while matching the Cortex surface, density, and focus language.

## Adding or changing UI

Before inventing a visual pattern:

1. inspect the rendered Home page;
2. inspect `HomePage.jsx` and the final Home refinement block in `src/index.css`;
3. inspect the closest existing Studio workflow and shared primitive;
4. reuse an existing pattern if its interaction model fits;
5. compose or add a scoped variant when the primitive fits but the presentation does not;
6. create a new pattern only when the interaction genuinely requires one;
7. verify desktop and narrow-window rendering, keyboard focus, theme behavior, overflow, and reduced motion.

New UI must match the application's density, type hierarchy, icon scale, surface treatment, interaction feedback, colour discipline, radius, and spacing rhythm. Consistency means a shared vocabulary, not identical page layouts. Do not force rows onto a visual canvas, cards onto a dense list, or one panel arrangement onto every workflow.

When a new pattern is justified, define its states and semantic role first. Keep page-specific tokens scoped. Promote a component or token to shared infrastructure only after at least two real consumers demonstrate the same contract.

## Avoid

Do not introduce these patterns into new Cortex Studio UI:

- decorative colour gradients, animated gradients, glassmorphism, glow, bloom, or neon effects;
- excessive or layered shadows;
- oversized rounded cards, nested cards, floating islands, and dashboard stat-card grids;
- coloured rounded-square icon boxes, rainbow feature icons, or tinted backgrounds behind every icon;
- giant headings, hero layouts, marketing whitespace, and unnecessarily tall controls;
- large empty-state artwork, decorative illustrations, or dramatic layouts for ordinary empty conditions;
- floating decorative bubbles, ambient particles, scanlines, or visual noise;
- arbitrary entrance animation, bouncing controls, hover displacement, and excessive scaling;
- excessive pills, badges, borders, and rounded containers;
- terminal syntax on every label: prefixes, brackets, underscores, uppercase, tracking, monospace, and orange must not become one universal treatment;
- semantic colours used as decoration or category colours used as status;
- low-contrast text, invisible focus, hover-only actions, or placeholder-only labels;
- generic SaaS layouts, generic AI dashboards, colourful launchers, gaming HUD styling, and marketing-site composition;
- blindly copied shadcn examples or a different component-library aesthetic for each feature;
- a new aesthetic per workflow.

CSS gradients used only to draw a subtle hairline grid or mask are an implementation technique, not permission for gradient-filled surfaces. Existing legacy effects elsewhere in the stylesheet are not precedent.

## Review checklist

Before merging visual work, confirm:

- the primary task and focal region are obvious at a glance;
- Home was used as the visual reference and any divergence is interaction-driven;
- most of the interface remains neutral and orange has a specific job;
- category colour appears once, not on icon, background, border, and label together;
- repeated scan-oriented content uses rows rather than independent cards;
- icons are Lucide, small, neutral, and not placed in coloured boxes;
- primary, secondary, metadata, shortcut, and status text are visibly distinct without terminal decoration everywhere;
- controls in the same toolbar share dimensions and feedback;
- panels feel structural and empty inspectors remain minimal;
- hover, selected, focus-visible, disabled, loading, empty, error, and overflow states are covered where relevant;
- the layout reflows deliberately at narrower desktop widths without accidental horizontal overflow;
- light and dark themes, keyboard navigation, contrast, and reduced motion have been checked;
- no global primitive restyle creates unrelated regressions.
