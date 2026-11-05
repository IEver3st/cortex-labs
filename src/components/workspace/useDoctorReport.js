import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { renderDoctorHtml, renderDoctorMarkdown, reportJson } from "../../lib/pack-doctor.js";

let generatorPromise = null;

export const errorText = (error) => String(error?.message || error);

export function doctorGenerator() {
  generatorPromise ??= getVersion().then((version) => `Cortex Studio ${version}`).catch(() => "Cortex Studio");
  return generatorPromise;
}

const safeName = (name) => String(name || "pack").replace(/[^A-Za-z0-9_.+-]+/g, "_").slice(0, 80) || "pack";

export default function useDoctorReport(report) {
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setStatus(null), [report]);

  const copy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(renderDoctorMarkdown(report));
      setStatus({ tone: "ok", text: "Copied the report as Markdown for a forum or Discord post." });
    } catch (error) {
      setStatus({ tone: "error", text: `Copy failed: ${errorText(error)}` });
    }
  }, [report]);

  const saveReport = useCallback(async () => {
    if (!report || saving) return;
    let target = null;
    try {
      target = await save({
        title: "Save the Pack Doctor report",
        defaultPath: `${safeName(report.title)}-pack-doctor.html`,
        filters: [
          { name: "HTML report", extensions: ["html"] },
          { name: "JSON (cortex.packDoctor v1)", extensions: ["json"] },
        ],
      });
    } catch (error) {
      setStatus({ tone: "error", text: `Could not open the save dialog: ${errorText(error)}` });
      return;
    }
    if (!target) return;
    setSaving(true);
    try {
      const text = /\.json$/i.test(target) ? reportJson(report) : renderDoctorHtml(report);
      await writeFile(target, new TextEncoder().encode(text));
      setStatus({ tone: "ok", text: "Saved the report to", path: target });
    } catch (error) {
      setStatus({ tone: "error", text: `The report was not saved to ${target}: ${errorText(error)}` });
    } finally {
      setSaving(false);
    }
  }, [report, saving]);

  return { status, saving, copy, saveReport, clearStatus: () => setStatus(null) };
}
