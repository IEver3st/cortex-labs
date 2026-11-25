import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArchetypeDef,
  buildPropFxManifest,
  parseYtypXml,
  renderYtypXml,
  sanitizeArchetypeName,
  suggestHdTextureDist,
  suggestLodDist,
} from "./prop-ytyp.js";

test("archetype def computes exact bounding sphere and asset type per format", () => {
  const def = buildArchetypeDef({
    name: "C:\\stream\\gsd_flashlight.ydr",
    format: "ydr",
    gtaBounds: { min: [-0.1, -0.2, 0], max: [0.1, 0.2, 0.4] },
    flags: 0,
  });
  assert.equal(def.name, "gsd_flashlight");
  assert.equal(def.assetType, "ASSET_TYPE_DRAWABLE");
  assert.equal(def.textureDictionary, "gsd_flashlight");
  assert.equal(def.physicsDictionary, "");
  assert.deepEqual(def.bsCentre.map((n) => Number(n.toFixed(4))), [0, 0, 0.2]);
  assert.ok(Math.abs(def.bsRadius - Math.hypot(0.1, 0.2, 0.2)) < 1e-6);
  assert.equal(def.flags, 0);

  const frag = buildArchetypeDef({ name: "breakable_box", format: "yft", gtaBounds: { min: [-1, -1, 0], max: [1, 1, 2] } });
  assert.equal(frag.assetType, "ASSET_TYPE_FRAGMENT");
  assert.equal(frag.physicsDictionary, "breakable_box");
});

test("renderYtypXml and parseYtypXml round-trip cleanly", () => {
  const a = buildArchetypeDef({
    name: "prop_cone_a",
    format: "ydr",
    gtaBounds: { min: [-0.25, -0.25, 0], max: [0.25, 0.25, 0.7] },
    textureDictionary: "pack_shared",
    lodDist: 80,
    hdTextureDist: 30,
    flags: 32,
  });
  const b = buildArchetypeDef({
    name: "prop_barrier_b",
    format: "yft",
    gtaBounds: { min: [-1.2, -0.3, 0], max: [1.2, 0.3, 1.0] },
    textureDictionary: "pack_shared",
  });
  const xml = renderYtypXml([a, b], { name: "road_pack" });
  assert.match(xml, /<CMapTypes>/);
  assert.match(xml, /<name>road_pack<\/name>/);

  const parsed = parseYtypXml(xml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "prop_cone_a");
  assert.equal(parsed[0].textureDictionary, "pack_shared");
  assert.deepEqual(parsed[0].bbMax, [0.25, 0.25, 0.7]);
  assert.equal(parsed[0].lodDist, 80);
  assert.equal(parsed[0].flags, 32);
  assert.equal(parsed[1].physicsDictionary, "prop_barrier_b");
});

test("sanitization, lod distance suggestions and fxmanifest generation", () => {
  assert.equal(sanitizeArchetypeName("C:\\props\\my prop!.ydr"), "my_prop_");
  assert.equal(sanitizeArchetypeName(""), "custom_prop");
  assert.ok(suggestLodDist(0.1) >= 30 && suggestLodDist(20) <= 300);
  assert.ok(suggestHdTextureDist(0.1) >= 15 && suggestHdTextureDist(20) <= 120);

  const manifest = buildPropFxManifest({ ytypName: "my_props.ytyp" });
  assert.match(manifest, /data_file 'DLC_ITYP_REQUEST' 'stream\/my_props\.ytyp'/);
});

test("parseYtypXml handles nested <extensions><Item .../></extensions> without truncating archetypes", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMapTypes>
  <archetypes>
    <Item type="CBaseArchetypeDef">
      <name>prop_with_light</name>
      <textureDictionary>prop_with_light</textureDictionary>
      <bbMin x="-0.5" y="-0.5" z="0" />
      <bbMax x="0.5" y="0.5" z="1.5" />
      <extensions>
        <Item type="CExtensionDefLightEffect">
          <name>lamp_fx</name>
        </Item>
      </extensions>
      <lodDist value="90" />
      <flags value="32" />
    </Item>
    <Item type="CBaseArchetypeDef">
      <name>prop_second</name>
      <textureDictionary>shared_txd</textureDictionary>
      <bbMin x="-1" y="-1" z="0" />
      <bbMax x="1" y="1" z="2" />
      <lodDist value="120" />
      <flags value="0" />
    </Item>
  </archetypes>
</CMapTypes>`;
  const parsed = parseYtypXml(xml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "prop_with_light");
  assert.equal(parsed[0].lodDist, 90);
  assert.equal(parsed[0].flags, 32);
  assert.equal(parsed[1].name, "prop_second");
  assert.equal(parsed[1].textureDictionary, "shared_txd");
});
