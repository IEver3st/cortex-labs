import React from "react";
import ReactDOM from "react-dom/client";
import Shell from "./Shell";
import "./index.css";
import { loadPrefs } from "./lib/prefs";
import { installConsoleLogCapture } from "./lib/console-log-buffer";

// Apply dark mode immediately before first render to prevent flash of unstyled content
const _initialPrefs = loadPrefs();
const _isDark = _initialPrefs?.defaults?.darkMode ?? true;
document.documentElement.classList.toggle("dark", _isDark);

installConsoleLogCapture();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
