import { EXPORT_FORMATS, exportFileStem } from "./eup-export.js";
import { getVehicleColor } from "./data/gta-vehicle-colors.js";
import { BUILD_ANGLES, CURRENT_BUILD, MAX_PAINTS, REPORT_CSS, encodePath, escapeHtml, figure } from "./kit-shoot.js";
import { exportReport, formatMiB, groupDoctorFindings, namesSubject } from "./pack-doctor.js";
import { withoutWindowPaths } from "./plain-error.js";

export const LISTING_SHOOT_SCHEMA = "cortex.listingShoot";
export const LISTING_SHOOT_VERSION = 1;

export const LIVERY_MOD_SLOT = "VMT_LIVERY_MOD";
export const HERO_ANGLES = Object.freeze(BUILD_ANGLES.filter((angle) => angle.id !== "view"));
export const STORE_FORMAT_IDS = Object.freeze(["landscape", "square", "portrait"]);
export const STORE_FORMATS = Object.freeze(STORE_FORMAT_IDS.map((id) => EXPORT_FORMATS.find((format) => format.id === id)));
export const TURNTABLE_SECONDS = Object.freeze([8, 12]);
export const LIGHTS_SECONDS = Object.freeze([6, 8, 10]);
export const LISTING_VIDEO_FPS = 30;
export const STORE_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const LISTING_BEFORE_AFTER_STYLES = Object.freeze(["side", "wipe"]);
export const DEFAULT_LISTING_PAINTS = Object.freeze([0, 111, 4, 27, 64, 88]);
export const DEFAULT_HERO_SIZE = Object.freeze({ width: 1920, height: 1080 });
export const LIVERY_TIMEOUT_SECONDS = 30;

export const DEFAULT_LISTING_SETTINGS = Object.freeze({
  heroAngles: ["front34", "rear34"],
  storeFormats: [...STORE_FORMAT_IDS],
  lineup: true,
  paintSheet: false,
  paints: [...DEFAULT_LISTING_PAINTS],
  beforeAfter: true,
  beforeAfterStyle: "side",
  kitParts: false,
  kitBuilds: false,
  turntable: true,
  turntableFormat: "landscape",
  turntableSeconds: 8,
  lights: false,
  lightsSeconds: 8,
});

function orderedIds(values, allowed) {
  if (!Array.isArray(values)) return null;
  return allowed.filter((id) => values.includes(id));
}

export function normalizeListingSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = DEFAULT_LISTING_SETTINGS;
  const paints = [];
  for (const entry of Array.isArray(source.paints) ? source.paints : defaults.paints) {
    if (Number.isInteger(entry) && getVehicleColor(entry) && !paints.includes(entry)) paints.push(entry);
    if (paints.length >= MAX_PAINTS) break;
  }
  return {
    heroAngles: orderedIds(source.heroAngles, HERO_ANGLES.map((angle) => angle.id)) ?? [...defaults.heroAngles],
    storeFormats: orderedIds(source.storeFormats, STORE_FORMAT_IDS) ?? [...defaults.storeFormats],
    lineup: source.lineup !== false,
    paintSheet: source.paintSheet === true,
    paints,
    beforeAfter: source.beforeAfter !== false,
    beforeAfterStyle: LISTING_BEFORE_AFTER_STYLES.includes(source.beforeAfterStyle) ? source.beforeAfterStyle : defaults.beforeAfterStyle,
    kitParts: source.kitParts === true,
    kitBuilds: source.kitBuilds === true,
    turntable: source.turntable !== false,
    turntableFormat: STORE_FORMAT_IDS.includes(source.turntableFormat) ? source.turntableFormat : defaults.turntableFormat,
    turntableSeconds: TURNTABLE_SECONDS.includes(source.turntableSeconds) ? source.turntableSeconds : defaults.turntableSeconds,
    lights: source.lights === true,
    lightsSeconds: LIGHTS_SECONDS.includes(source.lightsSeconds) ? source.lightsSeconds : defaults.lightsSeconds,
  };
}

export function formatTag(format) {
  return String(format?.label || format?.id || "").replace(":", "x");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function uniqueFile(used, folder, stem, extension = "png") {
  let name = stem;
  for (let n = 2; used.has(`${folder}/${name}`); n += 1) name = `${stem}-${n}`;
  used.add(`${folder}/${name}`);
  return `${folder}/${name}.${extension}`;
}

export function heroAngle(id) {
  return HERO_ANGLES.find((angle) => angle.id === id) || HERO_ANGLES[0];
}

function cleanSize(size) {
  const width = Math.round(Number(size?.width));
  const height = Math.round(Number(size?.height));
  return width > 0 && height > 0 ? { width, height } : { ...DEFAULT_HERO_SIZE };
}

export function planListingShoot({
  settings,
  heroSize = DEFAULT_HERO_SIZE,
  liveries = [],
  liveryNames = [],
  kit = null,
  builds = [],
  stagedLivery = false,
  originalShown = false,
  videoExtension = null,
  lights = { available: false, reason: "" },
} = {}) {
  const run = normalizeListingSettings(settings);
  const size = cleanSize(heroSize);
  const used = new Set();
  const skipped = [];
  const firstAngle = heroAngle(run.heroAngles[0] || "front34");
  const shotAngles = run.heroAngles.length ? run.heroAngles : [firstAngle.id];

  const heroes = run.heroAngles.map((id) => ({
    id: `hero:${id}`,
    kind: "hero",
    angle: id,
    label: heroAngle(id).label,
    ...size,
    file: uniqueFile(used, "hero", id),
  }));
  if (!heroes.length) skipped.push({ item: "Hero stills", reason: "No hero angle is picked." });

  const store = run.storeFormats.flatMap((formatId) => {
    const format = STORE_FORMATS.find((entry) => entry.id === formatId);
    return shotAngles.map((angleId) => ({
      id: `store:${formatId}:${angleId}`,
      kind: "store",
      format: formatId,
      angle: angleId,
      label: `${format.label} · ${heroAngle(angleId).label}`,
      width: format.width,
      height: format.height,
      file: uniqueFile(used, "store", `${formatTag(format)}-${angleId}`),
    }));
  });

  let beforeAfter = null;
  if (run.beforeAfter) {
    if (!stagedLivery) skipped.push({ item: "Before and after", reason: "No livery is loaded on the Livery step, so there is no after." });
    else if (!originalShown) skipped.push({ item: "Before and after", reason: "The model's own textures are off, so there is no original to compare with." });
    else beforeAfter = { id: "before-after", kind: "beforeAfter", angle: firstAngle.id, label: "Original and your livery", style: run.beforeAfterStyle, ...size, file: "before-after/livery.png" };
  }

  const liveryMods = kit?.slots?.find((slot) => slot.type === LIVERY_MOD_SLOT)?.mods || [];
  let lineup = null;
  if (run.lineup) {
    const items = [];
    const numbers = [...new Set(liveries.filter((entry) => Number.isInteger(entry) && entry > 0))].sort((a, b) => a - b);
    for (const number of numbers) {
      const name = liveryNames[number - 1] || `Livery ${number}`;
      items.push({ id: `sign:${number}`, kind: "sign", number, name, file: uniqueFile(used, "livery", `sign-${pad2(number)}-${exportFileStem(name, "livery")}`) });
    }
    for (const mod of liveryMods) {
      const name = mod.displayName || mod.label || mod.modelName || `Livery mod ${mod.index}`;
      items.push({ id: `mod:${mod.index}`, kind: "mod", modIndex: mod.index, name, file: uniqueFile(used, "livery", `mod-${pad2(mod.index)}-${exportFileStem(name, "livery")}`) });
    }
    if (items.length) lineup = { angle: firstAngle.id, ...size, items, sheet: items.length > 1 ? "sheets/liveries.png" : null };
    else skipped.push({ item: "Livery lineup", reason: "The vehicle has no texture liveries or livery mods." });
  }

  let paints = null;
  if (run.paintSheet) {
    if (run.paints.length) {
      paints = {
        angle: firstAngle.id,
        ...size,
        items: run.paints.map((index) => {
          const color = getVehicleColor(index);
          return { id: `paint:${index}`, kind: "paint", paint: index, name: color.name, hex: color.hex, file: uniqueFile(used, "paints", `paint-${pad2(index)}-${exportFileStem(color.name, "colour")}`) };
        }),
        sheet: run.paints.length > 1 ? "sheets/paints.png" : null,
      };
    } else {
      skipped.push({ item: "Paint sheet", reason: "No paint is picked." });
    }
  }

  let modKit = null;
  if (run.kitParts || run.kitBuilds) {
    if (!kit) {
      skipped.push({ item: "Mod kit", reason: "The vehicle has no mod kit with visible parts." });
    } else {
      modKit = {
        folder: "kit",
        kitName: kit.kitName,
        parts: run.kitParts,
        builds: run.kitBuilds ? [CURRENT_BUILD, ...builds.map((build) => build.name)] : [],
        angles: shotAngles,
      };
    }
  }

  const videos = [];
  const canRecord = (name) => {
    if (videoExtension) return true;
    skipped.push({ item: name, reason: "This runtime can't record video." });
    return false;
  };
  if (run.turntable && canRecord("Turntable video")) {
    const format = STORE_FORMATS.find((entry) => entry.id === run.turntableFormat);
    videos.push({
      id: "turntable",
      kind: "turntable",
      label: `Turntable ${format.label}`,
      width: format.width,
      height: format.height,
      seconds: run.turntableSeconds,
      fps: LISTING_VIDEO_FPS,
      spin: true,
      file: `video/turntable-${formatTag(format)}.${videoExtension}`,
    });
  }
  if (run.lights) {
    if (!lights?.available) {
      skipped.push({ item: "Night lights clip", reason: lights?.reason || "The vehicle has no siren lights to run." });
    } else if (canRecord("Night lights clip")) {
      videos.push({
        id: "lights",
        kind: "lights",
        label: "Night lights",
        width: STORE_FORMATS[0].width,
        height: STORE_FORMATS[0].height,
        seconds: run.lightsSeconds,
        fps: LISTING_VIDEO_FPS,
        spin: false,
        file: `video/lights-night.${videoExtension}`,
      });
    }
  }

  const stillCount = heroes.length + store.length + (beforeAfter ? 1 : 0) + (lineup?.items.length || 0) + (paints?.items.length || 0);
  return {
    settings: run,
    heroSize: size,
    heroes,
    store,
    beforeAfter,
    lineup,
    paints,
    kit: modKit,
    videos,
    skipped,
    stillCount,
    steps: stillCount + videos.length + (modKit ? 1 : 0),
    empty: stillCount === 0 && videos.length === 0 && !modKit,
  };
}

export const LISTING_ISSUE_CODES = Object.freeze({
  CAPTURE_FAILED: "error",
  LIVERY_FAILED: "error",
  LIVERY_TIMEOUT: "error",
  LIVERY_MOD_FAILED: "error",
  VIDEO_FAILED: "error",
  DUPLICATE_LIVERY: "warning",
  STORE_IMAGE_TOO_LARGE: "warning",
  LIVERY_COVERED: "warning",
  VIDEO_PAUSED: "info",
  VIDEO_SLOW: "info",
  UNTEXTURED: "info",
  NOT_MADE: "info",
});

export function listingIssue(code, message, context = {}) {
  return { code, severity: LISTING_ISSUE_CODES[code] || "warning", message, ...context };
}

function liveryName(item) {
  return item.kind === "sign" ? `${item.name} (sign ${item.number})` : `${item.name} (livery mod ${item.modIndex})`;
}

export function collectListingIssues(plan) {
  const issues = [];
  const stills = [...plan.heroes, ...plan.store, ...(plan.beforeAfter ? [plan.beforeAfter] : []), ...(plan.paints?.items || [])];
  for (const item of stills) {
    if (item.error) issues.push(listingIssue("CAPTURE_FAILED", `${item.label || item.name || item.file} wasn't saved: ${item.error}`, { item: item.id }));
  }
  for (const item of plan.store) {
    if (item.saved && item.bytes > STORE_IMAGE_LIMIT_BYTES) {
      issues.push(listingIssue("STORE_IMAGE_TOO_LARGE", `${item.file} is ${(item.bytes / 1048576).toFixed(1)} MB; Tebex takes images up to 5 MB.`, { item: item.id }));
    }
  }
  for (const item of plan.lineup?.items || []) {
    const name = liveryName(item);
    if (item.timedOut) issues.push(listingIssue("LIVERY_TIMEOUT", `${name} didn't show within ${LIVERY_TIMEOUT_SECONDS} seconds, so it wasn't shot.`, { item: item.id }));
    else if (item.loadError) issues.push(listingIssue(item.kind === "sign" ? "LIVERY_FAILED" : "LIVERY_MOD_FAILED", `${name} didn't load: ${item.loadError}`, { item: item.id }));
    else if (item.error) issues.push(listingIssue("CAPTURE_FAILED", `${name} wasn't saved: ${item.error}`, { item: item.id }));
    if (item.duplicateOf) issues.push(listingIssue("DUPLICATE_LIVERY", `${name} looks identical to ${item.duplicateOf}.`, { item: item.id }));
  }
  for (const video of plan.videos) {
    if (video.error) issues.push(listingIssue("VIDEO_FAILED", `${video.label} wasn't recorded: ${video.error}`, { item: video.id }));
    if (video.pauses > 0) {
      issues.push(listingIssue("VIDEO_PAUSED", `${video.label} paused ${video.pauses === 1 ? "once" : `${video.pauses} times`} while the window was hidden and carried on where it stopped.`, { item: video.id }));
    }
    if (video.saved && video.renderSeconds > video.seconds + 1) {
      issues.push(listingIssue("VIDEO_SLOW", `${video.label} took ${video.renderSeconds.toFixed(1)} s to record instead of ${video.seconds} s, so the clip runs longer and turns slower.`, { item: video.id }));
    }
  }
  for (const entry of plan.skipped) issues.push(listingIssue("NOT_MADE", `Not made: ${entry.item}. ${entry.reason}`));
  return issues;
}

export function liveryDuplicateNames(duplicates, items) {
  const names = new Map(items.map((item) => [item.id, liveryName(item)]));
  return new Map([...duplicates].map(([id, original]) => [id, names.get(original) || original]));
}

function savedFile(item) {
  return item?.saved ? item.file : null;
}

function savedThumb(item) {
  return item?.saved && item.thumb ? item.thumb : null;
}

export function listingDoctorRecord(result) {
  if (result?.status === "ready" && result.report) return { status: "checked", reason: "", report: exportReport(result.report) };
  return { status: "not-run", reason: withoutWindowPaths(result?.reason || "Pack Doctor didn't run for this shoot."), report: null };
}

export function buildListingManifest({ createdAt, appVersion = "", modelName, plan, complete, kit = null, issues = [], packDoctor = null }) {
  const still = (item, extra = {}) => ({
    id: item.id,
    label: item.label || item.name || "",
    width: item.width ?? plan.heroSize.width,
    height: item.height ?? plan.heroSize.height,
    file: savedFile(item),
    thumb: savedThumb(item),
    ...extra,
  });
  return {
    schema: LISTING_SHOOT_SCHEMA,
    version: LISTING_SHOOT_VERSION,
    generator: appVersion ? `Cortex Studio ${appVersion}` : "Cortex Studio",
    createdAt,
    complete: complete === true,
    vehicle: { modelName },
    settings: plan.settings,
    heroes: plan.heroes.map((item) => still(item, { angle: item.angle })),
    store: plan.store.map((item) => still(item, { format: item.format, angle: item.angle, bytes: item.bytes ?? null })),
    beforeAfter: plan.beforeAfter ? still(plan.beforeAfter, { angle: plan.beforeAfter.angle, style: plan.beforeAfter.style }) : null,
    liveries: plan.lineup ? {
      angle: plan.lineup.angle,
      sheet: plan.lineup.sheetSaved ? plan.lineup.sheet : null,
      items: plan.lineup.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        number: item.number ?? null,
        modIndex: item.modIndex ?? null,
        name: item.name,
        file: savedFile(item),
        thumb: savedThumb(item),
        duplicateOf: item.duplicateOf || null,
      })),
    } : null,
    paints: plan.paints ? {
      angle: plan.paints.angle,
      sheet: plan.paints.sheetSaved ? plan.paints.sheet : null,
      items: plan.paints.items.map((item) => ({ id: item.id, paint: { index: item.paint, name: item.name, hex: item.hex }, file: savedFile(item), thumb: savedThumb(item) })),
    } : null,
    kit,
    videos: plan.videos.map((video) => ({
      id: video.id,
      label: video.label,
      width: video.width,
      height: video.height,
      fps: video.fps,
      seconds: video.seconds,
      frames: video.frames ?? null,
      file: savedFile(video),
    })),
    notMade: plan.skipped.map((entry) => ({ ...entry })),
    issues,
    packDoctor: packDoctor || listingDoctorRecord(null),
  };
}

const DOCTOR_LABEL = Object.freeze({ error: "error", warn: "warning", info: "note" });
const DOCTOR_CSS = `ul.issues .warn span{color:var(--warn)}.doctor ul.issues>li>span{flex:0 0 96px}ul.issues li>div{min-width:0}ul.issues p{margin:0}
.check{font-weight:650}.check code{margin-left:8px}.why{margin:4px 0 0!important;color:var(--muted)}.fix{margin:4px 0 0!important}.fix b{margin-right:6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
ul.files{list-style:none;margin:8px 0 0;padding:0}ul.files li{display:block;padding:6px 0 6px 12px;border:0;border-left:2px solid var(--line)}ul.files li+li{margin-top:4px}ul.files code{display:block;overflow-wrap:anywhere}`;

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

export function doctorCountsText(counts) {
  if (!counts) return "";
  return [
    plural(counts.error || 0, "error"),
    plural(counts.warn || 0, "warning"),
    plural(counts.info || 0, "note"),
    `${counts.notChecked || 0} not checked`,
  ].join(", ");
}

function renderDoctorSection(record) {
  const data = record?.status === "checked" ? record.report : null;
  if (!data) {
    return `<section class="doctor"><h2>Pack Doctor</h2><p>Not run: ${escapeHtml(record?.reason || "Pack Doctor didn't run for this shoot.")}</p></section>`;
  }
  const groups = groupDoctorFindings(data.findings || []).map((group) => {
    const items = group.items.map(({ finding, text, fix }) => `<li><p>${namesSubject(finding) ? `<b>${escapeHtml(finding.subject)}</b>: ` : ""}${escapeHtml(text)}</p>${fix ? `<p class="fix"><b>Fix</b>${escapeHtml(fix)}</p>` : ""}${finding.file ? `<code>${escapeHtml(finding.file)}</code>` : ""}</li>`).join("");
    return `<li class="${escapeHtml(group.severity)}"><span>${DOCTOR_LABEL[group.severity] || escapeHtml(group.severity)}</span><div><p class="check">${escapeHtml(group.title)}<code>${escapeHtml(group.code)} · ${group.items.length}</code></p>${group.explanation ? `<p class="why">${escapeHtml(group.explanation)}</p>` : ""}${group.fix ? `<p class="fix"><b>Fix</b>${escapeHtml(group.fix)}</p>` : ""}<ul class="files">${items}</ul></div></li>`;
  }).join("");
  const notChecked = (data.notChecked || []).map((entry) => `<li><span>not checked</span><div><p>${escapeHtml(entry.what)}: ${escapeHtml(entry.reason)}</p>${entry.file && entry.file !== entry.what ? `<code>${escapeHtml(entry.file)}</code>` : ""}</div></li>`).join("");
  const escrowed = (data.escrowed || []).map((entry) => `<li><span>escrowed</span><div><p>${escapeHtml(entry.name)}</p></div></li>`).join("");
  const total = data.memory?.total;
  const facts = [
    `<span>${escapeHtml(doctorCountsText(data.counts))}</span>`,
    `<span>${data.complete ? "complete" : "partial check"}</span>`,
    total ? `<span>Streamed ${formatMiB(total.physical)} MiB graphics, ${formatMiB(total.virtual)} MiB system</span>` : "",
    ...(data.facts || []).map((fact) => `<span>${escapeHtml(fact.label)}: ${escapeHtml(fact.value)}</span>`),
  ].join("");
  const clear = data.complete ? "No problems found." : "No problems found in what Pack Doctor could check.";
  return `<section class="doctor"><h2>Pack Doctor<small>A read-only check of ${escapeHtml(data.title)}'s own files, as the Health check in the Meta tab runs it.</small></h2>
<p class="facts">${facts}</p>
${groups ? `<ul class="issues">${groups}</ul>` : `<p>${clear}</p>`}${escrowed ? `<h3>Escrowed, not checked</h3><ul class="issues">${escrowed}</ul>` : ""}${notChecked ? `<h3>Not checked</h3><ul class="issues">${notChecked}</ul>` : ""}</section>`;
}

function section(title, body) {
  return body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : "";
}

function grid(figures, wide = false) {
  return figures ? `<div class="grid${wide ? " wide" : ""}">${figures}</div>` : "";
}

export function renderListingReport(manifest) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of manifest.issues || []) counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  const issueRows = (manifest.issues || []).map((entry) => `<li class="${escapeHtml(entry.severity)}"><span>${escapeHtml(entry.severity)}</span><code>${escapeHtml(entry.code)}</code>${escapeHtml(entry.message)}</li>`).join("");
  const sized = (item) => `${item.width}×${item.height}`;
  const heroes = (manifest.heroes || []).map((item) => figure(item.file, item.label, sized(item))).join("");
  const store = (manifest.store || []).map((item) => figure(item.file, item.label, sized(item))).join("");
  const pair = manifest.beforeAfter ? figure(manifest.beforeAfter.file, manifest.beforeAfter.label) : "";
  const liveries = (manifest.liveries?.items || []).map((item) => figure(
    item.file,
    item.name,
    `${item.kind === "sign" ? `sign ${item.number}` : `livery mod ${item.modIndex}`}${item.duplicateOf ? ` · same as ${item.duplicateOf}` : ""}`,
  )).join("");
  const paints = (manifest.paints?.items || []).map((item) => figure(item.file, item.paint.name, `colour ${item.paint.index}`)).join("");
  const sheets = [
    manifest.liveries?.sheet ? figure(manifest.liveries.sheet, "Livery sheet") : "",
    manifest.paints?.sheet ? figure(manifest.paints.sheet, "Paint sheet") : "",
  ].join("");
  const videos = (manifest.videos || []).map((video) => (video.file
    ? `<a href="${encodePath(video.file)}">${escapeHtml(video.label)}</a> <code>${video.width}×${video.height} · ${video.seconds} s · ${video.fps} fps</code>`
    : `<span>${escapeHtml(video.label)}: not recorded</span>`)).join("<br>");
  const kit = manifest.kit;
  const kitBody = (kit?.runs || []).map((entry) => `<p class="media">${entry.report ? `<a href="${encodePath(entry.report)}">${escapeHtml(entry.mode === "builds" ? "Builds" : "Every part")} report</a>` : escapeHtml(entry.mode === "builds" ? "Builds" : "Every part")} · ${escapeHtml(kit.name || "")} · ${entry.shots ?? 0} shots</p>`).join("");
  const title = manifest.vehicle?.modelName || "Vehicle";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Listing shoot · ${escapeHtml(title)}</title>
<style>
${REPORT_CSS}${DOCTOR_CSS}</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="facts"><span>Listing shoot</span><span>${escapeHtml(manifest.createdAt || "")}</span><span>${manifest.complete ? "complete" : "partial run"}</span><span>${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes</span></p>
</header>
${manifest.issues?.length ? `<section><h2>Checks</h2><ul class="issues">${issueRows}</ul></section>` : "<section><h2>Checks</h2><p>No problems found.</p></section>"}
${renderDoctorSection(manifest.packDoctor)}
${section("Hero stills", grid(heroes))}${section("Store formats", grid(store))}${section("Before and after", grid(pair, true))}${section("Livery lineup", grid(liveries))}${section("Paints", grid(paints))}${section("Sheets", grid(sheets, true))}${section("Videos", videos ? `<p class="media">${videos}</p>` : "")}${section("Mod kit", kitBody)}
</body>
</html>
`;
}
