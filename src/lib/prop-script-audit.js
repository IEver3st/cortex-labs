// Whole-script prop resource audit for FiveM resources (fxmanifest.lua,
// stream/*.ydr/.ydd/.yft/.ytd, .ytyp.xml cross-references, and RSC7 streamed memory).
// Pure functions — runs under node:test.

import { describeStreamedFile, formatMiB } from "./pack-doctor.js";

const FIVEM_STREAM_LIMIT_BYTES = 16 * 1024 * 1024;
const SINGLE_ASSET_WARN_BYTES = 8 * 1024 * 1024;
const ITYP_REQUEST_RE = /data_file\s+['"]DLC_ITYP_REQUEST['"]\s+['"]([^'"]+)['"]/gi;

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function stemOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

export function extractManifestItypEntries(manifestText) {
  if (typeof manifestText !== "string" || !manifestText) return [];
  // Strip Lua block comments and line comments so disabled lines do not count.
  const stripped = manifestText
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .replace(/--[^\n]*/g, "");
  const entries = [];
  for (const match of stripped.matchAll(ITYP_REQUEST_RE)) {
    if (match[1]) entries.push(match[1].trim());
  }
  return entries;
}

/**
 * Audits an entire FiveM prop script or stream folder.
 */
export function auditPropScript({
  label = "script",
  hasManifest = false,
  manifestText = "",
  models = [],
  ytypXmls = [],
  ytypDefs = [],
  streamedFiles = [],
} = {}) {
  const findings = [];
  const push = (severity, code, message, fix = "") => findings.push({ severity, code, message, fix });

  const itypEntries = extractManifestItypEntries(manifestText);
  const modelStems = new Set((models || []).map((m) => stemOf(m.name || m.path)));

  // 1. fxmanifest.lua DLC_ITYP_REQUEST wiring
  if (hasManifest && (ytypXmls.length > 0 || ytypDefs.length > 0) && itypEntries.length === 0) {
    push(
      "error",
      "MANIFEST_NO_ITYP",
      "The script has .ytyp definitions, but fxmanifest.lua has no data_file 'DLC_ITYP_REQUEST' entry.",
      "Add data_file 'DLC_ITYP_REQUEST' 'stream/<your_pack>.ytyp' to fxmanifest.lua so FiveM registers the props.",
    );
  } else if (hasManifest && models.length > 0 && ytypXmls.length === 0 && itypEntries.length === 0) {
    push(
      "info",
      "NO_YTYP_FOUND",
      `No .ytyp.xml or DLC_ITYP_REQUEST found for ${models.length} streamed ${models.length === 1 ? "model" : "models"}.`,
      "Custom props need a compiled .ytyp registered via DLC_ITYP_REQUEST unless they only replace base-game models.",
    );
  }

  // 2. Cross-reference streamed models <-> .ytyp.xml archetypes
  if (ytypDefs.length > 0) {
    const defNames = new Set();
    for (const def of ytypDefs) {
      if (def?.name) defNames.add(def.name.toLowerCase());
      if (def?.assetName) defNames.add(def.assetName.toLowerCase());
    }
    const missingFromYtyp = [...modelStems].filter((stem) => !defNames.has(stem)).sort();
    if (missingFromYtyp.length > 0) {
      const sample = missingFromYtyp.slice(0, 6).join(", ");
      push(
        "warn",
        "MODELS_MISSING_YTYP",
        `${missingFromYtyp.length} streamed ${missingFromYtyp.length === 1 ? "model has" : "models have"} no archetype in .ytyp.xml: ${sample}${missingFromYtyp.length > 6 ? ` (+${missingFromYtyp.length - 6} more)` : ""}.`,
        "Generate archetype entries in the QA tab so every prop spawns with valid bounds and texture dictionary.",
      );
    }

    const orphanDefs = ytypDefs
      .filter((def) => {
        const n = (def?.name || "").toLowerCase();
        const a = (def?.assetName || "").toLowerCase();
        return (n || a) && !modelStems.has(n) && !modelStems.has(a);
      })
      .map((def) => def.name || def.assetName);
    if (orphanDefs.length > 0) {
      const sample = orphanDefs.slice(0, 6).join(", ");
      push(
        "info",
        "ORPHAN_YTYP_DEFS",
        `${orphanDefs.length} .ytyp.xml ${orphanDefs.length === 1 ? "entry has" : "entries have"} no matching model in stream/: ${sample}${orphanDefs.length > 6 ? ` (+${orphanDefs.length - 6} more)` : ""}.`,
        "Remove unused entries or verify the matching .ydr/.yft is in stream/.",
      );
    }
  }

  // 3. RSC7 streamed memory across all streamed files
  const described = (streamedFiles || []).map(describeStreamedFile).filter(Boolean);
  let totalPhysical = 0;
  let totalVirtual = 0;
  const oversized = [];
  const heavy = [];
  for (const file of described) {
    if (!file.checked) continue;
    totalPhysical += file.physical || 0;
    totalVirtual += file.virtual || 0;
    const peak = Math.max(file.physical || 0, file.virtual || 0);
    if (peak > FIVEM_STREAM_LIMIT_BYTES) oversized.push({ ...file, peak });
    else if (peak > SINGLE_ASSET_WARN_BYTES) heavy.push({ ...file, peak });
  }
  oversized.sort((a, b) => b.peak - a.peak);
  heavy.sort((a, b) => b.peak - a.peak);

  if (oversized.length > 0) {
    const names = oversized.slice(0, 5).map((f) => `${baseName(f.path)} (${formatMiB(f.peak)} MiB)`).join(", ");
    push(
      "error",
      "OVERSIZED_STREAM_ASSETS",
      `${oversized.length} ${oversized.length === 1 ? "file exceeds" : "files exceed"} FiveM's 16 MiB streaming warning limit: ${names}.`,
      "Downscale oversized textures (4K → 2K cuts VRAM by 75%), ensure BC1/BC7 compression, or split shared .ytd dictionaries.",
    );
  }
  if (heavy.length > 0) {
    const names = heavy.slice(0, 5).map((f) => `${baseName(f.path)} (${formatMiB(f.peak)} MiB)`).join(", ");
    push(
      "warn",
      "HEAVY_STREAM_ASSETS",
      `${heavy.length} ${heavy.length === 1 ? "file is" : "files are"} over 8 MiB: ${names}.`,
      "Consider reducing texture sizes or poly counts for lighter client streaming.",
    );
  }

  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  return {
    label,
    modelCount: models.length,
    ytypDefCount: ytypDefs.length,
    itypEntries,
    checkedFiles: described.filter((f) => f.checked).length,
    totalPhysical,
    totalVirtual,
    topMemoryFiles: described
      .filter((f) => f.checked)
      .sort((a, b) => Math.max(b.physical || 0, b.virtual || 0) - Math.max(a.physical || 0, a.virtual || 0))
      .slice(0, 8),
    counts,
    findings,
  };
}

export function formatScriptAuditMarkdown(audit) {
  if (!audit) return "";
  const lines = [
    `# Script Prop Audit — \`${audit.label}\``,
    "",
    `- **Streamed models:** ${audit.modelCount}`,
    `- **YTYP archetypes parsed:** ${audit.ytypDefCount}`,
    `- **fxmanifest DLC_ITYP_REQUEST:** ${audit.itypEntries.length ? audit.itypEntries.join(", ") : "None"}`,
    `- **Total RSC7 memory:** ${formatMiB(audit.totalPhysical)} MiB GPU · ${formatMiB(audit.totalVirtual)} MiB RAM (${audit.checkedFiles} checked files)`,
    `- **Result:** ${audit.counts.error} errors, ${audit.counts.warn} warnings, ${audit.counts.info} notes`,
    "",
  ];
  if (!audit.findings.length) {
    lines.push("All script checks passed.");
  } else {
    lines.push("## Findings");
    for (const f of audit.findings) {
      lines.push(`- **[${f.severity.toUpperCase()} · ${f.code}]** ${f.message}`);
      if (f.fix) lines.push(`  - *Fix:* ${f.fix}`);
    }
  }
  if (audit.topMemoryFiles.length > 0) {
    lines.push("", "## Largest streamed files");
    for (const f of audit.topMemoryFiles) {
      lines.push(`- \`${baseName(f.path)}\`: ${formatMiB(f.physical)} MiB GPU · ${formatMiB(f.virtual)} MiB RAM`);
    }
  }
  return lines.join("\n");
}
