export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        main: ["Syne", "sans-serif"],
        hud: ["DM Mono", "ui-monospace", "monospace"],
      },
      colors: {
        // Semantic aliases
        background:     "var(--mg-bg)",
        foreground:     "var(--mg-fg)",
        card:           "#FCFAF8",
        "card-offwhite":"#FCFAF8",
        popover:        "#FCFAF8",
        primary:        "var(--mg-primary)",
        secondary:      "var(--mg-surface)",
        muted:          "var(--mg-surface)",
        "muted-foreground": "var(--mg-muted)",
        accent:         "var(--mg-primary)",
        destructive:    "var(--mg-destructive)",
        border:         "var(--mg-border)",
        input:          "var(--mg-input-bg)",
        ring:           "var(--mg-primary)",
        // Named palette aliases (colorpalette.md)
        paper:          "#F3F1EC",
        bone:           "#F3F1EC",
        canvas:         "#F3F1EC",
        stone:          "#EAE7E0",
        surface:        "#EAE7E0",
        "soft-black":   "#1F1E1D",
        ink:            "#1F1E1D",
        "muted-grey":   "#5A554F",
        silt:           "#5A554F",
        graphite:       "#5A554F",
        "soft-tertiary":"#8A837A",
        "beige-border": "#DCD7CE",
        clay:           "#D97952",
        warn:           "#D97952",
        "danger-accent":"#C2544A",
        "danger-surface":"#FDF4F2",
        // Panels (Tauri app)
        panel:          "rgba(234, 231, 224, 0.35)",
        hover:          "#FCFAF8",
      },
      boxShadow: {
        panel: "0 4px 16px rgba(31, 30, 29, 0.1)",
        card:  "0 1px 4px rgba(31, 30, 29, 0.08)",
      },
    },
  },
};
