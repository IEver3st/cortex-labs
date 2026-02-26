208:const [layerFilter, setLayerFilter] = useState("all");
469:if (mode === "current") toExp = [selectedVariant].filter(Boolean);
470:else if (mode === "selected") toExp = variants.filter((v) => selectedVariantIds.has(v.id));
555:if (ctrl && !shift && k === "e") { e.preventDefault(); handleExport("current"); return; }
556:if (ctrl && shift && k === "e") { e.preventDefault(); handleExport("all"); return; }
592:const viewerTextureTarget = liveryTarget || "all";
613:if (layerFilter === "all") return true;
685:{["all", "visible", "modified"].map((f) => (
687:{f === "all" ? "All" : f === "visible" ? "Visible" : "Modified"}
901:{openMenu === "output" && outputFolder && (
999:<button type="button" className="vp-cmd-export-btn" onClick={() => handleExport("all")} disabled={!psdPath || !outputFolder || variants.length === 0}>
1007:<button type="button" className="vp-dropdown-item" onClick={() => { handleExport("current"); setShowExportMenu(false); }}>Export current variant</button>
1009:<button type="button" className="vp-dropdown-item" onClick={() => { handleExport("selected"); setShowExportMenu(false); }}>Export selected ({selectedVariantIds.size})</button>
1011:<button type="button" className="vp-dropdown-item" onClick={() => { handleExport("all"); setShowExportMenu(false); }}>Export all ({variants.length})</button>
1013:<button type="button" className="vp-dropdown-item" onClick={async () => { await handleExport("all"); setShowExportMenu(false); if (outputFolder && isTauriRuntime) { try { const { openPath } = await import("@tauri-apps/plugin-opener"); await openPath(outputFolder); } catch {} } }}>Export all + open folder</button>
1091:<button type="button" className="vp-batch-btn" onClick={() => handleExport("all")} disabled={!psdPath || !outputFolder}>
