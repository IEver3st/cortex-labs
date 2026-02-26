const fs = require("fs");

const [, , filePath, startArg, endArg] = process.argv;
if (!filePath) {
  console.error("Usage: node tmp_read_lines.js <file> [start] [end]");
  process.exit(1);
}

const text = fs.readFileSync(filePath, "utf8");
const lines = text.split(/\r?\n/);
const start = Number.isFinite(Number(startArg)) ? Math.max(1, Number(startArg)) : 1;
const end = Number.isFinite(Number(endArg))
  ? Math.max(start, Number(endArg))
  : lines.length;

for (let i = start; i <= end && i <= lines.length; i += 1) {
  console.log(`${i}: ${lines[i - 1]}`);
}
