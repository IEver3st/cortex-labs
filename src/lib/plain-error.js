const KNOWN = [
  [/os error (2|3)\b|cannot find the (file|path)|no such file|not found on disk|ENOENT/i, "File not found. It may have been moved or renamed."],
  [/os error 5\b|access is denied|permission denied|EACCES|EPERM/i, "Cortex isn't allowed to use this file. Check its permissions or pick another folder."],
  [/os error (32|33)\b|being used by another process|EBUSY/i, "Another program has this file open. Close it and try again."],
  [/os error (39|112)\b|not enough space|disk is full|ENOSPC/i, "The disk is full. Free some space and try again."],
  [/os error 123\b|filename, directory name, or volume label syntax/i, "That file name isn't valid on Windows."],
  [/os error 206\b|filename or extension is too long|ENAMETOOLONG/i, "The file path is too long for Windows."],
];

const WINDOWS_PATH = /(?<![\w/\\])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^:*?"<>|\r\n`']*?(?=\s+(?:[A-Za-z]:[\\/]|\\\\)|[:*?"<>|\r\n`']|$)/g;
const LIMIT = 160;

function clip(text) {
  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text;
}

export function withoutWindowPaths(text) {
  return String(text ?? "").replace(/\\\\\?\\UNC\\/gi, "\\\\").replace(/\\\\\?\\/g, "").replace(WINDOWS_PATH, (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path);
}

function subjectBefore(line, index) {
  const lead = line.slice(0, index);
  const colon = lead.lastIndexOf(": ");
  if (colon <= 0) return "";
  return withoutWindowPaths(lead.slice(0, colon))
    .replace(/^failed to [a-z ]+ at path:\s*(.+?)\s+with error$/i, "$1")
    .trim();
}

export function plainError(error, fallback = "Something went wrong.") {
  const raw = typeof error === "string" ? error : error?.message ?? (error == null ? "" : String(error));
  const detail = String(raw || "").trim();
  if (!detail) return { text: fallback, detail: "" };
  const firstLine = detail.split(/\r?\n/)[0].replace(/^(?:(?:Error|TypeError|RangeError):\s*)+/, "");
  for (const [pattern, sentence] of KNOWN) {
    const match = pattern.exec(firstLine) || pattern.exec(detail);
    if (!match) continue;
    const subject = match.input === firstLine ? subjectBefore(firstLine, match.index) : "";
    return { text: clip(subject ? `${subject}: ${sentence}` : sentence), detail };
  }
  const text = clip(firstLine);
  return { text, detail: text === detail ? "" : detail };
}
