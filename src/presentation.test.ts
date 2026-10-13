import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lockedFrameBounds, readSlide, withSlide } from "./presentation";

const frame = { id: "frame", type: "frame", x: 0, y: 0, width: 1600, height: 900, version: 1, isDeleted: false, frameId: null };

test("slide size locks round-trip without discarding existing metadata", () => {
  const data = withSlide({ other: true }, { aspectRatio: 16 / 9 });
  assert.equal(data?.other, true);
  assert.equal(readSlide({ ...frame, customData: data }).aspectRatio, 16 / 9);
  assert.equal(readSlide({ ...frame, customData: { slide: { aspectRatio: -1 } } }).aspectRatio, null);
  assert.equal(readSlide(frame).aspectRatio, null);
});

test("locked frames keep their ratio and anchor across horizontal and vertical resize", () => {
  assert.deepEqual(lockedFrameBounds(frame, { ...frame, width: 800 }, 16 / 9), { x: 0, y: 0, width: 800, height: 450 });
  assert.deepEqual(lockedFrameBounds(frame, { ...frame, x: 800, width: 800 }, 16 / 9), { x: 800, y: 0, width: 800, height: 450 });
  assert.deepEqual(lockedFrameBounds(frame, { ...frame, y: 450, height: 450 }, 16 / 9), { x: 0, y: 450, width: 800, height: 450 });
});
