import React from "react";
import ReactDOM from "react-dom/client";
import Shell from "./Shell";
import "./index.css";
import { loadPrefs } from "./lib/prefs";
import { installConsoleLogCapture } from "./lib/console-log-buffer";
import { applyAppearance } from "./lib/theme";

// Apply the stored appearance before first render to prevent a theme flash.
const _initialPrefs = loadPrefs();
applyAppearance({
  colorScheme: _initialPrefs?.defaults?.colorScheme,
  themePreset: _initialPrefs?.defaults?.themePreset,
  legacyDarkMode: _initialPrefs?.defaults?.darkMode ?? true,
});

installConsoleLogCapture();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
