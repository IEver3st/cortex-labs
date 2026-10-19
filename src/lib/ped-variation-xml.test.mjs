import test from "node:test";
import assert from "node:assert/strict";
import {
  ANCHOR_NAMES,
  PedVariationError,
  buildPedVariation,
  componentData,
  defaultPropMeta,
  drawableEntry,
  itemTextureCount,
  parsePedVariationXml,
  pedVariationXml,
  propEntry,
  withAddedTextures,
} from "./ped-variation-xml.js";

const drawable = (textures, { propMask = 1, ownsCloth = false } = {}) => ({
  propMask,
  numAlternatives: 0,
  textures: textures.map((texId) => ({ texId, distribution: 255 })),
  ownsCloth,
});

function samplePack() {
  return buildPedVariation({
    name: "mp_m_sample",
    dlcName: "mp_m_sample",
    components: new Map([
      [9, [{ drawable: drawable([0]), info: null }, { drawable: drawable([0, 1], { propMask: 17 }), info: null }]],
      [11, [{ drawable: drawable([0, 0, 0], { ownsCloth: true }), info: null }]],
    ]),
    props: new Map([[0, [defaultPropMeta(0, 0, 2)]], [6, [defaultPropMeta(6, 0, 1), defaultPropMeta(6, 1, 3)]]]),
  });
}

test("a built pack numbers its components, infos and props", () => {
  const model = samplePack();
  assert.deepEqual(model.availComp, [255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 1]);
  assert.equal(componentData(model, 9).numAvailTex, 3);
  assert.equal(componentData(model, 11).numAvailTex, 3);
  assert.equal(componentData(model, 4), null);
  assert.deepEqual(model.compInfos.map((info) => [info.compIdx, info.drawblIdx]), [[9, 0], [9, 1], [11, 0]]);
  assert.equal(drawableEntry(model, 9, 1).drawable.propMask, 17);
  assert.equal(drawableEntry(model, 9, 1).info.drawblIdx, 1);
  assert.equal(model.props.numAvailProps, 3);
  assert.deepEqual(model.props.anchors, [{ props: [2], anchor: ANCHOR_NAMES[0] }, { props: [1, 3], anchor: ANCHOR_NAMES[6] }]);
  assert.deepEqual(propEntry(model, 6, 1).textures.map((texture) => texture.texId), [0, 1, 2]);
  assert.equal(model.flags.texVariations, true);
});

test("the XML reads back to the same model and the same text", () => {
  const model = samplePack();
  const xml = pedVariationXml(model);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<CPedVariationInfo name="mp_m_sample">\n <bHasTexVariations value="true" \/>/);
  assert.match(xml, /\n <availComp>255 255 255 255 255 255 255 255 255 0 255 1<\/availComp>\n/);
  const parsed = parsePedVariationXml(xml);
  assert.deepEqual(parsed, model);
  assert.equal(pedVariationXml(parsed), xml);
});

test("a file without a name and long byte arrays keep CodeWalker's layout", () => {
  const model = buildPedVariation({
    name: null,
    dlcName: "mp_m_rows",
    props: new Map([[0, Array.from({ length: 12 }, (_, propId) => defaultPropMeta(0, propId, 1))]]),
  });
  const xml = pedVariationXml(model);
  assert.match(xml, /\n<CPedVariationInfo>\n/);
  // More than ten values: rows of ten, one level deeper than the element.
  assert.match(xml, /\n {4}<props>\n {5}1 1 1 1 1 1 1 1 1 1\n {5}1 1\n {4}<\/props>\n/);
  assert.equal(pedVariationXml(parsePedVariationXml(xml)), xml);
});

test("adding textures updates the counts the game reads", () => {
  const model = samplePack();
  const more = withAddedTextures(model, { isProp: false, slotId: 9, index: 0 }, 2);
  assert.equal(itemTextureCount(more, { isProp: false, slotId: 9, index: 0 }), 3);
  assert.equal(componentData(more, 9).numAvailTex, 5);
  assert.deepEqual(drawableEntry(more, 9, 0).drawable.textures.map((texture) => texture.texId), [0, 0, 0]);
  assert.equal(itemTextureCount(model, { isProp: false, slotId: 9, index: 0 }), 1, "the source model is untouched");

  const hats = withAddedTextures(model, { isProp: true, slotId: 6, index: 0 }, 2);
  assert.deepEqual(propEntry(hats, 6, 0).textures.map((texture) => texture.texId), [0, 1, 2]);
  assert.deepEqual(hats.props.anchors[1].props, [3, 3]);

  const single = buildPedVariation({ name: "x", dlcName: "x", components: new Map([[11, [{ drawable: drawable([0]), info: null }]]]) });
  assert.equal(single.flags.texVariations, false);
  assert.equal(withAddedTextures(single, { isProp: false, slotId: 11, index: 0 }, 1).flags.texVariations, true);
  assert.throws(() => withAddedTextures(model, { isProp: false, slotId: 9, index: 5 }, 1), PedVariationError);
  assert.throws(() => withAddedTextures(model, { isProp: true, slotId: 1, index: 0 }, 1), PedVariationError);
});

test("XML with fields Cortex does not know is refused, not dropped", () => {
  const xml = pedVariationXml(samplePack()).replace(" <bIsSuperLOD", ' <bSomethingNew value="true" />\n <bIsSuperLOD');
  assert.throws(() => parsePedVariationXml(xml), PedVariationError);
  assert.throws(() => parsePedVariationXml("<CMapTypes />"), PedVariationError);
  assert.throws(() => parsePedVariationXml("not xml"), PedVariationError);
});
