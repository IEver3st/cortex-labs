import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every dropdown in the app is the Radix-based `components/ui/select.jsx`:
// one look, keyboard behaviour, and portal layering (it opens above dialogs).
// A native <select> renders an OS menu that ignores the theme.

const SRC = fileURLToPath(new URL("..", import.meta.url));

function jsxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsxFiles(path);
    return /\.(jsx|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("dropdowns use ui/select, not a native <select>", () => {
  const offenders = jsxFiles(SRC).flatMap((file) => readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => (/<select[\s>]/.test(line) ? [`${relative(SRC, file)}:${index + 1}`] : [])));
  assert.deepEqual(offenders, [], "Replace these with Select/SelectTrigger/SelectContent/SelectItem from components/ui/select.jsx");
});
