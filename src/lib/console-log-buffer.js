const MAX_ENTRIES = 200;
const MAX_BYTES = 24 * 1024;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

let installed = false;
let entries = [];
let totalBytes = 0;

function getByteLength(value) {
  return new TextEncoder().encode(value).length;
}

function serializeError(error) {
  if (!(error instanceof Error)) return String(error);
  if (typeof error.stack === "string" && error.stack.trim()) return error.stack.trim();
  return `${error.name}: ${error.message}`;
}

function serializeArg(arg, depth = 0, seen = new WeakSet()) {
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean" || arg == null) return String(arg);
  if (typeof arg === "bigint") return `${arg}n`;
  if (typeof arg === "function") return `[Function ${arg.name || "anonymous"}]`;
  if (arg instanceof Error) return serializeError(arg);
  if (typeof Element !== "undefined" && arg instanceof Element) {
    return `<${arg.tagName.toLowerCase()}>`;
  }
  if (depth > 2) return "[Object]";
  if (typeof arg !== "object") return String(arg);
  if (seen.has(arg)) return "[Circular]";
  seen.add(arg);

  if (Array.isArray(arg)) {
    return `[${arg.map((item) => serializeArg(item, depth + 1, seen)).join(", ")}]`;
  }

  try {
    return JSON.stringify(
      arg,
      (_, value) => {
        if (typeof value === "bigint") return `${value}n`;
        if (value instanceof Error) return serializeError(value);
        if (typeof Element !== "undefined" && value instanceof Element) {
          return `<${value.tagName.toLowerCase()}>`;
        }
        return value;
      },
      2,
    );
  } catch {
    const constructorName = arg?.constructor?.name;
    return constructorName ? `[${constructorName}]` : "[Object]";
  }
}

function trimEntries() {
  while (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const removed = entries.shift();
    if (!removed) break;
    totalBytes -= getByteLength(JSON.stringify(removed));
  }
}

function recordEntry(level, args) {
  const message = args.map((arg) => serializeArg(arg)).join(" ").trim();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: message || "(empty console call)",
  };
  entries.push(entry);
  totalBytes += getByteLength(JSON.stringify(entry));
  trimEntries();
}

export function installConsoleLogCapture() {
  if (installed || typeof console === "undefined") return;
  installed = true;

  for (const method of CONSOLE_METHODS) {
    const original = typeof console[method] === "function" ? console[method].bind(console) : console.log.bind(console);
    console[method] = (...args) => {
      recordEntry(method, args);
      original(...args);
    };
  }
}

export function getConsoleLogEntries() {
  return entries.slice();
}

export function clearConsoleLogEntries() {
  entries = [];
  totalBytes = 0;
}
