import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PLATE_TEXT,
  PLATE_MAX_LENGTH,
  PLATE_STYLE_NAMES,
  PLATE_IMAGE_MAX_EDGE,
  composePlateImage,
  fitPlateImageSize,
  normalizePlateDefinitions,
  normalizePlateImage,
  normalizePlateText,
  plateComposeScale,
  plateLetterIndices,
} from "./license-plate.js";

test("plate text keeps the game's characters and length", () => {
  assert.equal(PLATE_MAX_LENGTH, 8);
  assert.equal(normalizePlateText("lspd 911"), "LSPD 911");
  assert.equal(normalizePlateText("ab-c_1!2"), "ABC12");
  assert.equal(normalizePlateText("123456789"), "12345678");
  assert.equal(normalizePlateText(null), "");
  assert.equal(normalizePlateText(DEFAULT_PLATE_TEXT), DEFAULT_PLATE_TEXT);
});

test("letters map to the font atlas and short text is centred", () => {
  // Digits from 0, letters from 10, space at 63 (carcols.ymt offsets).
  assert.deepEqual(plateLetterIndices("46EEK572"), [4, 6, 14, 14, 20, 5, 7, 2]);
  assert.deepEqual(plateLetterIndices("LSPD"), [63, 63, 21, 28, 25, 13, 63, 63]);
  assert.deepEqual(plateLetterIndices("ABC"), [63, 63, 10, 11, 12, 63, 63, 63]);
  assert.deepEqual(plateLetterIndices(""), Array(8).fill(63));
  assert.deepEqual(plateLetterIndices("A", { numericOffset: 1, alphabeticOffset: 20, spaceOffset: 0 }), [0, 0, 0, 20, 0, 0, 0, 0]);
});

test("plate definitions are normalised and named by game index", () => {
  const definitions = normalizePlateDefinitions({
    numericOffset: 0,
    alphabeticOffset: 10,
    spaceOffset: 63,
    defaultIndex: 0,
    plates: [
      { index: 0, diffuse: "plate01", fontColor: "#0f2352" },
      { index: 12, diffuse: "plate_mod_07" },
      { index: 3 },
    ],
  });
  assert.equal(definitions.plates.length, 2);
  assert.equal(definitions.plates[0].name, PLATE_STYLE_NAMES[0]);
  assert.equal(definitions.plates[1].name, "Sprunk");
  assert.deepEqual(definitions.offsets, { numericOffset: 0, alphabeticOffset: 10, spaceOffset: 63 });
  assert.deepEqual(normalizePlateDefinitions(null).plates, []);
});

function solid(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255; }
  return { data, width, height };
}

test("composition draws text in the font colour only inside the text box", () => {
  const background = solid(32, 16, 200);
  // A font whose every cell is fully inside the glyph.
  const font = solid(64, 16, 255);
  const plate = { fontExtents: [0.25, 0.25, 0.75, 0.75], fontColor: "#102030" };
  const image = composePlateImage({ background, font, plate, text: "88888888", scale: 1 });
  assert.equal(image.width, 32);
  const pixel = (x, yTopDown) => {
    const y = image.height - 1 - yTopDown;
    const i = (y * image.width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  assert.deepEqual(pixel(16, 8), [16, 32, 48]);
  assert.deepEqual(pixel(2, 2), [200, 200, 200]);
  // An empty font leaves the background untouched.
  const blank = composePlateImage({ background, font: solid(64, 16, 0), plate, text: "88888888", scale: 1 });
  assert.equal(blank.data[(8 * 32 + 16) * 4], 200);
});

test("custom plate images keep only supported image paths and an import stamp", () => {
  assert.deepEqual(normalizePlateImage({ path: " C:/plates/gsd.PNG ", stamp: 12 }), { path: "C:/plates/gsd.PNG", stamp: 12 });
  assert.deepEqual(normalizePlateImage({ path: String.raw`E:\res\plate.dds` }), { path: String.raw`E:\res\plate.dds`, stamp: 0 });
  assert.equal(normalizePlateImage({ path: "C:/plates/gsd.psd" }), null, "formats the plate cannot decode are dropped");
  assert.equal(normalizePlateImage({ path: "" }), null);
  assert.equal(normalizePlateImage("C:/plates/gsd.png"), null, "a bare string is not the stored shape");
  assert.equal(normalizePlateImage(null), null);
  assert.equal(normalizePlateImage({ path: "C:/a.png", stamp: -1 }).stamp, 0);
});

test("custom plate images are decoded within the size cap and rejected when absurd", () => {
  assert.deepEqual(fitPlateImageSize(512, 256), { width: 512, height: 256 }, "small images keep their size");
  assert.deepEqual(fitPlateImageSize(4096, 2048), { width: PLATE_IMAGE_MAX_EDGE, height: PLATE_IMAGE_MAX_EDGE / 2 });
  assert.deepEqual(fitPlateImageSize(300, 3000), { width: 102, height: PLATE_IMAGE_MAX_EDGE });
  assert.throws(() => fitPlateImageSize(0, 128), /Unsupported plate image size/);
  assert.throws(() => fitPlateImageSize(100000, 128), /Unsupported plate image size/);
  assert.throws(() => fitPlateImageSize(12.5, 128), /Unsupported plate image size/);
});

test("a custom background composes at a capped, whole-pixel size", () => {
  const plate = { fontExtents: [0, 0, 1, 1], fontColor: "#000000" };
  assert.equal(plateComposeScale({ width: 256, height: 128 }), 2);
  assert.equal(plateComposeScale({ width: 1024, height: 512 }), 1);
  const scale = plateComposeScale({ width: 700, height: 350 });
  const image = composePlateImage({ background: solid(700, 350, 90), font: solid(64, 16, 0), plate, text: "", scale });
  assert.equal(image.width, PLATE_IMAGE_MAX_EDGE);
  assert.equal(image.height, 512);
  assert.equal(image.data.length, image.width * image.height * 4);
  assert.equal(image.data[0], 90, "blank text leaves the custom background as is");
});
