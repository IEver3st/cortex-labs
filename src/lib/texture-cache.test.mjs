import test from "node:test";
import assert from "node:assert/strict";
import {
  createTextureCache,
  estimateTextureBytes,
  getTextureCacheKey,
} from "./texture-cache.js";

function fakeTexture(width, height) {
  const texture = { image: { width, height }, userData: {}, disposed: 0, sourceReleased: 0 };
  texture.dispose = () => { texture.disposed += 1; };
  texture.userData.releaseSource = () => { texture.sourceReleased += 1; };
  return texture;
}

test("cache key ignores the reload token and encodes flip", () => {
  assert.equal(getTextureCacheKey("C:/a.png", true), "C:/a.png::fy");
  assert.equal(getTextureCacheKey("C:/a.png", false), "C:/a.png::nf");
  assert.equal(getTextureCacheKey("", true), "");
});

test("byte estimate covers RGBA8 plus a mip chain", () => {
  assert.equal(estimateTextureBytes(fakeTexture(4096, 4096)), Math.ceil(4096 * 4096 * 4 * 1.33));
  assert.equal(estimateTextureBytes({ image: { naturalWidth: 2, naturalHeight: 2 } }), Math.ceil(16 * 1.33));
  assert.equal(estimateTextureBytes({ image: null }), 0);
  assert.equal(estimateTextureBytes(null), 0);
});

test("replacing a key disposes the old texture once its last ref is released", () => {
  const cache = createTextureCache({ limit: 4 });
  const first = fakeTexture(16, 16);
  const second = fakeTexture(16, 16);
  cache.set("k", first);
  cache.retain(first);
  assert.equal(cache.getGeneration("k"), 1);

  cache.set("k", second);
  assert.equal(cache.get("k"), second);
  assert.equal(cache.getGeneration("k"), 2);
  assert.equal(first.disposed, 0, "still referenced, must not dispose yet");

  cache.release(first);
  assert.equal(first.disposed, 1);
  assert.equal(first.sourceReleased, 1);
  assert.equal(cache.stats().size, 1);
});

test("replacing an unreferenced key disposes immediately", () => {
  const cache = createTextureCache({ limit: 4 });
  const first = fakeTexture(16, 16);
  cache.set("k", first);
  cache.set("k", fakeTexture(16, 16));
  assert.equal(first.disposed, 1);
});

test("count limit evicts oldest unreferenced entries only", () => {
  const cache = createTextureCache({ limit: 2, byteBudget: Number.MAX_SAFE_INTEGER });
  const a = fakeTexture(8, 8);
  const b = fakeTexture(8, 8);
  const c = fakeTexture(8, 8);
  cache.set("a", a);
  cache.retain(a);
  cache.set("b", b);
  cache.set("c", c);
  assert.equal(a.disposed, 0, "referenced entry survives");
  assert.equal(b.disposed, 1, "oldest unreferenced entry evicted");
  assert.equal(cache.stats().size, 2);
});

test("byte budget evicts even when under the count limit", () => {
  const perTexture = estimateTextureBytes(fakeTexture(1024, 1024));
  const cache = createTextureCache({ limit: 16, byteBudget: perTexture * 2 + 1 });
  const a = fakeTexture(1024, 1024);
  const b = fakeTexture(1024, 1024);
  const c = fakeTexture(1024, 1024);
  cache.set("a", a);
  cache.set("b", b);
  cache.set("c", c);
  assert.equal(a.disposed, 1);
  assert.equal(b.disposed, 0);
  assert.equal(c.disposed, 0);
  assert.ok(cache.stats().totalBytes <= perTexture * 2 + 1);
});

test("over-budget referenced entries are evicted after release", () => {
  const perTexture = estimateTextureBytes(fakeTexture(512, 512));
  const cache = createTextureCache({ limit: 16, byteBudget: perTexture });
  const a = fakeTexture(512, 512);
  const b = fakeTexture(512, 512);
  cache.set("a", a);
  cache.retain(a);
  cache.set("b", b);
  assert.equal(a.disposed, 0);
  cache.release(a);
  assert.equal(a.disposed, 1);
  assert.equal(cache.stats().size, 1);
});

test("releasing a texture that was never cached disposes it", () => {
  const cache = createTextureCache();
  const loose = fakeTexture(4, 4);
  cache.release(loose);
  assert.equal(loose.disposed, 1);
});
