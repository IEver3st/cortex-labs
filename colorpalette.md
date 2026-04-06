# Cortex Color Palette

A complete reference for every color token used across the Cortex Website — hex values, CSS variables, Tailwind aliases, dark-mode variants, and usage rules.

---

## Core Palette

### 1. Paper Base — `#F3F1EC`

| Property | Value |
|---|---|
| Hex | `#F3F1EC` |
| HSL | `hsl(44, 26%, 94%)` |
| CSS variable | `--background` |
| Tailwind tokens | `bg-background`, `bg-paper`, `bg-bone`, `bg-canvas` |

**Light mode role:** The root application background. Applied to the `<body>`, the `#root` shell, and any full-bleed page wrappers. Every surface sits on top of this color.

**Dark mode value:** `#1F1E1D` (Soft Black becomes the new base — the palette inverts).

---

### 2. Stone Sidebar — `#EAE7E0`

| Property | Value |
|---|---|
| Hex | `#EAE7E0` |
| HSL | `hsl(43, 18%, 90%)` |
| CSS variable | `--secondary` / `--muted` |
| Tailwind tokens | `bg-secondary`, `bg-stone`, `bg-muted`, `bg-surface` |

**Light mode role:** The main sidebar background and all default badge/chip backgrounds. Also used as the `--muted` background for low-emphasis sections and input rings. Slightly darker and warmer than Paper Base to establish visual hierarchy without heavy contrast.

**Fumadocs override:** `--fd-background: #EAE7E0` — Fumadocs docs panels use Stone as their root background.

**Dark mode value:** `#33312F` (`hsl(20, 4%, 20%)`)

---

### 3. Card Off-White — `#FCFAF8`

| Property | Value |
|---|---|
| Hex | `#FCFAF8` |
| HSL | `hsl(30, 25%, 98%)` |
| CSS variable | `--card` / `--popover` |
| Tailwind tokens | `bg-card`, `bg-card-offwhite`, `bg-hover`, `bg-popover` |

**Light mode role:** Background for all main content cards, secondary (outline-style) buttons, popovers, dropdown menus, and command palettes. The warmest and lightest surface — used wherever content needs to lift off the Paper Base background.

**Fumadocs override:** `--fd-card: #FCFAF8`, `--fd-popover: #FCFAF8`

**Dark mode value:** `#2A2827` (`hsl(15, 3%, 16%)`)

---

### 4. Soft Black — `#1F1E1D`

| Property | Value |
|---|---|
| Hex | `#1F1E1D` |
| HSL | `hsl(0, 3%, 12%)` |
| CSS variable | `--foreground` / `--primary` |
| Tailwind tokens | `text-foreground`, `text-soft-black`, `text-ink`, `bg-primary`, `bg-soft-black` |

**Light mode role:** Primary text color for all headings, body copy, and labels. Also the fill for primary (solid) buttons and dark inverted card surfaces. It is a very dark warm grey — not pure black — keeping the interface feeling organic rather than stark.

**Dark mode value:** Becomes the page background (`--background: #1F1E1D`). Foreground inverts to Paper Base `#F3F1EC`.

---

### 5. Muted Grey — `#5A554F`

| Property | Value |
|---|---|
| Hex | `#5A554F` |
| HSL | `hsl(30, 6%, 35%)` |
| CSS variable | `--muted-foreground` |
| Tailwind tokens | `text-muted-foreground`, `text-muted-grey`, `text-silt`, `text-graphite` |

**Light mode role:** Secondary text — descriptions, captions, metadata rows, and UI icon fills. Also used for inactive/disabled button states, side-navigation labels when not active, and supporting copy that should not compete with primary headings.

**Dark mode value:** `#A39D96` (`hsl(33, 8%, 62%)`) — lightened so it remains legible against the dark background.

---

### 6. Soft Tertiary — `#8A837A`

| Property | Value |
|---|---|
| Hex | `#8A837A` |
| HSL | `hsl(30, 5%, 50%)` (approx) |
| CSS variable | Shares `--muted-foreground` in Tailwind; explicit in Fumadocs as `--fd-muted-foreground` |
| Tailwind tokens | `text-soft-tertiary` (maps to `--muted-foreground`) |

**Role (both modes):** The lightest text tier — placeholder text inside inputs, tiny hint labels, footnote-level annotations, and index numbers in lists. Used when text needs to be present but must recede as much as possible. In Fumadocs documentation panels it is the dedicated `--fd-muted-foreground`.

---

### 7. Beige Border — `#DCD7CE`

| Property | Value |
|---|---|
| Hex | `#DCD7CE` |
| HSL | `hsl(38, 19%, 83%)` |
| CSS variable | `--border` / `--input` |
| Tailwind tokens | `border-border`, `border-beige-border` |

**Light mode role:** Used for **all** standard borders and dividers — card outlines, table row separators, input field borders, sidebar edges, and horizontal rules. Keeping one border color across the entire UI creates visual calm.

**Dark mode value:** `#4A4744` (`hsl(20, 4%, 28%)`)

---

### 8. Warm Clay — `#D97952`

| Property | Value |
|---|---|
| Hex | `#D97952` |
| HSL | `hsl(17, 64%, 59%)` |
| CSS variable | `--accent` / `--ring` (light) / `--sidebar-primary` |
| Tailwind tokens | `text-accent`, `bg-accent`, `text-clay`, `text-warn`, `bg-warn`, `border-ring` |

**Role (both modes — value unchanged):** The single interactive accent across the entire site. Applied to:

- **Active navigation states** — the active link indicator, sidebar highlight.
- **Interactive highlights** — hover underlines on links, focus rings on inputs and buttons.
- **Primary text accents** — bold callout words, highlighted statistics.
- **Warning / pending badges** — badge background set at **10–15% opacity** (`rgba(217, 121, 82, 0.12)`) with the solid clay text on top.
- **CTA buttons** — primary call-to-action fills where Soft Black would be too heavy.
- **Text selection** — browser `::selection` highlight uses `rgba(217, 121, 82, 0.35)`.
- **Chart series 1** — the first data series in all graphs and charts.
- **Fumadocs accents** — `--fd-primary`, `--fd-accent`, `--fd-ring`, `--sidebar-ring`.

Warm Clay is the **only** warm accent; it adds energy without being aggressive. Never use it for destructive actions.

---

### 9. Danger Red — `#C2544A`

| Property | Value |
|---|---|
| Hex | `#C2544A` |
| HSL | `hsl(4, 52%, 53%)` |
| CSS variable | `--destructive` |
| Tailwind tokens | `text-destructive`, `bg-destructive`, `text-danger-accent` |

**Role (both modes — value unchanged):** Reserved **strictly** for destructive or critical-error states:

- Delete / remove action buttons.
- Form validation error messages and border highlights.
- Critical alert banners and toast notifications.
- Error badge text.

Always pair with the Danger Surface background (below) when used inline. Never use Danger Red for warnings or informational states — those belong to Warm Clay.

---

### 10. Danger Surface — `#FDF4F2`

| Property | Value |
|---|---|
| Hex (light) | `#FDF4F2` |
| HSL (light) | `hsl(10, 73%, 97%)` |
| CSS variable | `--danger-surface` |
| Tailwind tokens | `bg-danger-surface` |

**Light mode role:** The soft background tint behind inline error messages, destructive confirmation dialogs, and error badges. Danger Red text (`#C2544A`) always sits on this surface for inline errors.

**Dark mode value:** `#3A2422` (`hsl(0, 30%, 18%)`) — a deep maroon that maintains sufficient contrast for the Danger Red text in dark contexts.

---

## Sidebar System Colors

The sidebar uses a dedicated set of tokens that are slightly darker than the main surface tier.

| Token | Light | Dark |
|---|---|---|
| `--sidebar-background` | `#E0DBD3` (`hsl(36, 15%, 85%)`) | `#1A1918` (`hsl(20, 3%, 10%)`) |
| `--sidebar-foreground` | `#1F1E1D` | `#F3F1EC` |
| `--sidebar-primary` | `#D97952` (Warm Clay) | `#D97952` (Warm Clay) |
| `--sidebar-accent` | `hsl(36, 13%, 80%)` | `hsl(20, 4%, 14%)` |
| `--sidebar-border` | `#DCD7CE` (Beige Border) | `#4A4744` |
| `--sidebar-ring` | `#D97952` (Warm Clay) | `#F3F1EC` |

---

## Chart Series Colors

Used sequentially for data visualisation. The order is intentional — Warm Clay leads, with increasingly neutral tones following.

| Series | Color | Hex |
|---|---|---|
| chart-1 | Warm Clay | `#D97952` |
| chart-2 | Muted Grey | `#5A554F` |
| chart-3 | Danger Red | `#C2544A` |
| chart-4 | Stone Sidebar | `#EAE7E0` |
| chart-5 | Soft Black | `#1F1E1D` |

---

## Semantic Role Summary

| Purpose | Color | Hex |
|---|---|---|
| Page / app background | Paper Base | `#F3F1EC` |
| Sidebar & badge backgrounds | Stone Sidebar | `#EAE7E0` |
| Cards, popovers, buttons (secondary) | Card Off-White | `#FCFAF8` |
| Primary text & solid buttons | Soft Black | `#1F1E1D` |
| Secondary text, icons, disabled states | Muted Grey | `#5A554F` |
| Placeholders, hints, footnotes | Soft Tertiary | `#8A837A` |
| All borders & dividers | Beige Border | `#DCD7CE` |
| Interactive accent, active states, warnings | Warm Clay | `#D97952` |
| Destructive actions, critical errors (text) | Danger Red | `#C2544A` |
| Destructive / error background tint | Danger Surface | `#FDF4F2` |
| Text selection highlight | Warm Clay 35% | `rgba(217,121,82,0.35)` |

---

## Tailwind Token Alias Map

Many semantic aliases exist in `tailwind.config.ts`. They all resolve to the same underlying CSS variable.

| Alias | Resolves to |
|---|---|
| `ink` | `--foreground` (Soft Black / Paper Base inverted) |
| `bone` | `--background` (Paper Base) |
| `canvas`, `paper` | `--background` |
| `silt`, `graphite`, `muted-grey`, `soft-tertiary` | `--muted-foreground` |
| `clay`, `warn` | `#D97952` (Warm Clay, static) |
| `surface`, `stone` | `--secondary` (Stone Sidebar) |
| `hover`, `card-offwhite` | `--card` (Card Off-White) |
| `soft-black` | `--foreground` |
| `beige-border` | `--border` |
| `danger-accent` | `--destructive` (Danger Red) |
| `danger-surface` | `--danger-surface` |

---

## Typography Note

All text is set in **Syne** (display and body). Use weight, style, and size — not extra colors — to create hierarchy within the palette above. Newsreader (serif) is available for editorial long-form content exclusively.
