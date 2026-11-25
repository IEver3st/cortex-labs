import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPropScript, extractManifestItypEntries, formatScriptAuditMarkdown } from "./prop-script-audit.js";

// RSC7 page flags helper: base shift 4 -> 0x200 << 4 = 8192 bytes/page; 128 pages -> 1 MiB.
function rsc7FlagsForMiB(mib) {
  // Using bits 17..23 (<<4 pages) and shift=10 (512 * 1024 = 512 KiB/page):
  // Let's pick shift=11 (1 MiB per page) -> bits 0..3 = 11, bit 27 = 1 page => 1 MiB,
  // or shift=13 (4 MiB per page), bit 27 = 1, bit 26 = 1 => 3 pages * 4 MiB = 12 MiB,
  // shift=14 (8 MiB per page), bit 25 = 1 (4 pages) => 32 MiB!
  if (mib >= 20) return (1 << 25) | 13; // 4 * 4 MiB = 16? wait: 0x200 * 2^13 = 4 MiB; 4 pages = 16; let's use shift=14 -> 8 MiB/page * 3 = 24 MiB
  return (1 << 27) | 11; // 1 * 1 MiB = 1 MiB
}

test("extractManifestItypEntries parses single and double quoted DLC_ITYP_REQUEST lines and ignores Lua comments", () => {
  const entries = extractManifestItypEntries(`
    fx_version 'cerulean'
    -- data_file 'DLC_ITYP_REQUEST' 'stream/commented_out.ytyp'
    --[[
      data_file 'DLC_ITYP_REQUEST' 'stream/block_commented.ytyp'
    ]]
    data_file 'DLC_ITYP_REQUEST' 'stream/pack_a.ytyp' -- trailing comment
    data_file "DLC_ITYP_REQUEST" "stream/pack_b.ytyp"
  `);
  assert.deepEqual(entries, ["stream/pack_a.ytyp", "stream/pack_b.ytyp"]);
});

test("auditPropScript flags missing DLC_ITYP_REQUEST, missing/orphan archetypes, and >16 MiB files", () => {
  const bigFlags = (1 << 27) | (1 << 26) | 14; // (1+2) * (512 * 16384) = 24 MiB
  const smallFlags = (1 << 27) | 11; // 1 MiB

  const audit = auditPropScript({
    label: "my-props",
    hasManifest: true,
    manifestText: "fx_version 'cerulean'\ngame 'gta5'\n",
    models: [
      { name: "prop_chair.ydr", path: "C:/res/stream/prop_chair.ydr" },
      { name: "prop_table.ydr", path: "C:/res/stream/prop_table.ydr" },
    ],
    ytypXmls: ["C:/res/stream/my_props.ytyp.xml"],
    ytypDefs: [
      { name: "prop_chair", assetName: "prop_chair" },
      { name: "prop_deleted", assetName: "prop_deleted" },
    ],
    streamedFiles: [
      { path: "C:/res/stream/prop_chair.ytd", magic: "RSC7", physicalFlags: bigFlags, virtualFlags: smallFlags, bytes: 100 },
    ],
  });

  const codes = audit.findings.map((f) => f.code);
  assert.ok(codes.includes("MANIFEST_NO_ITYP"));
  assert.ok(codes.includes("MODELS_MISSING_YTYP"));
  assert.ok(codes.includes("ORPHAN_YTYP_DEFS"));
  assert.ok(codes.includes("OVERSIZED_STREAM_ASSETS"));
  assert.equal(audit.counts.error, 2);

  const md = formatScriptAuditMarkdown(audit);
  assert.match(md, /Script Prop Audit/);
  assert.match(md, /prop_chair\.ytd/);
  assert.equal(rsc7FlagsForMiB(1) > 0, true);
});
