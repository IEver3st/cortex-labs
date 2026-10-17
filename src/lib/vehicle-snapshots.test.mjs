import assert from "node:assert/strict";
import test from "node:test";
import { packName, plateLabel, stagedLiveryCount } from "./vehicle-snapshots.js";

test("a plate drops the prefix the whole pack shares, at a word boundary only", () => {
  const pack = ["GSDSS17Caprice", "gsdss23camaross", "GSDSSGator", "GSDSSGatorTrailer"];
  assert.equal(plateLabel("GSDSS17Caprice", pack), "17Caprice");
  assert.equal(plateLabel("gsdss23camaross", pack), "23camaross");
  assert.equal(plateLabel("GSDSSGatorTrailer", pack), "GatorTrailer");
  // "Cha" ends inside a word in both names.
  assert.equal(plateLabel("Charger", ["Charger", "Challenger"]), "Charger");
  assert.equal(plateLabel("pd_tahoe", ["pd_tahoe", "pd_charger"]), "tahoe");
  // Nothing to compare against, or too little left.
  assert.equal(plateLabel("GSDSS17Caprice", ["GSDSS17Caprice"]), "GSDSS17Caprice");
  assert.equal(plateLabel("car1", ["car1", "car2"]), "car1");
});

test("staged liveries count new images and removals", () => {
  assert.equal(stagedLiveryCount(null), 0);
  assert.equal(stagedLiveryCount({ items: [{}, {}], removed: [3] }), 3);
  assert.equal(stagedLiveryCount({ items: [] }), 0);
});

test("a pack is named for its one resource, or else its folder", () => {
  const one = [{ resource: "GSDSoundOffSignalPack", resourcePath: "C:/dl/GSDSoundOffSignalPack" }];
  assert.equal(packName("C:\\dl\\GSDSoundOffSignalPack\\stream", one), "GSDSoundOffSignalPack");
  const two = [...one, { resource: "solo", resourcePath: "C:/dl/solo" }];
  assert.equal(packName("C:\\dl\\", two), "dl");
  assert.equal(packName("D:/", []), "D:");
});
