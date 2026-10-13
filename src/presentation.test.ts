import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lockedFrameBounds, readSlide, withSlide } from "./presentation";

const frame = {
  id: "frame",
  type: "frame",
  x: 0,
  y: 0,
  width: 1600,
  height: 900,
  version: 1,
  isDeleted: false,
  frameId: null,
};

test("slide size locks round-trip without discarding existing metadata", () => {
  const data = withSlide({ other: true }, { aspectRatio: 16 / 9 });
  assert.equal(data?.other, true);
  assert.equal(readSlide({ ...frame, customData: data }).aspectRatio, 16 / 9);
  assert.equal(
    readSlide({ ...frame, customData: { slide: { aspectRatio: -1 } } })
      .aspectRatio,
    null,
  );
  assert.equal(readSlide(frame).aspectRatio, null);
});

test("locked frames keep their ratio and anchor across horizontal and vertical resize", () => {
  assert.deepEqual(lockedFrameBounds(frame, { ...frame, width: 800 }, 16 / 9), {
    x: 0,
    y: 0,
    width: 800,
    height: 450,
  });
  assert.deepEqual(
    lockedFrameBounds(frame, { ...frame, x: 800, width: 800 }, 16 / 9),
    { x: 800, y: 0, width: 800, height: 450 },
  );
  assert.deepEqual(
    lockedFrameBounds(frame, { ...frame, y: 450, height: 450 }, 16 / 9),
    { x: 0, y: 450, width: 800, height: 450 },
  );
});

import {
  buildLabel,
  buildTargets,
  getSlides,
  readBuild,
  reorderBuilds,
} from "./presentation";

test("build authoring resolves bound text and reorders sparse steps without losing effects", () => {
  const first = {
    ...frame,
    id: "a",
    type: "rectangle",
    frameId: frame.id,
    customData: { other: true, build: { step: 2, effect: "rise" } },
  };
  const label = {
    ...frame,
    id: "label",
    type: "text",
    frameId: frame.id,
    containerId: "a",
    text: "API\nserver",
  };
  const second = {
    ...first,
    id: "b",
    customData: { build: { step: 9, effect: "fade" } },
  };
  const [slide] = getSlides([frame, first, label, second]);
  assert.deepEqual(
    buildTargets(slide, [first, label]).map((e) => e.id),
    ["a"],
  );
  assert.deepEqual(buildTargets(slide, [{ ...first, id: "outside" }]), []);
  assert.equal(buildLabel(slide, first), "API server");
  assert.equal(slide.ranks.get("label"), 1);
  const updates = reorderBuilds(slide, 0, 1);
  assert.equal(readBuild({ ...first, customData: updates.get("a") })?.step, 2);
  assert.equal(readBuild({ ...second, customData: updates.get("b") })?.step, 1);
  assert.equal(
    readBuild({ ...first, customData: updates.get("a") })?.effect,
    "rise",
  );
  assert.equal(updates.get("a")?.other, true);
  assert.equal(updates.has("label"), false);
});

import { buildAppearance } from "./presentation";

test("build previews hide later steps, animate the current reveal, and preserve authored appearance", () => {
  const element = {
    ...frame,
    type: "rectangle",
    id: "object",
    y: 80,
    opacity: 60,
  };
  const slide = {
    ranks: new Map([[element.id, 1]]),
    effects: new Map([[element.id, "rise" as const]]),
  };
  assert.deepEqual(buildAppearance(slide, element, 0), { opacity: 0, y: 80 });
  assert.deepEqual(buildAppearance(slide, element, 1, 0), {
    opacity: 0,
    y: 108,
  });
  assert.deepEqual(buildAppearance(slide, element, 1, 1), {
    opacity: 60,
    y: 80,
  });
  assert.deepEqual(
    buildAppearance(
      { ...slide, effects: new Map([[element.id, "appear"]]) },
      element,
      1,
      0,
    ),
    { opacity: 60, y: 80 },
  );
  assert.deepEqual(
    buildAppearance({ ...slide, ranks: new Map() }, element, 0),
    { opacity: 60, y: 80 },
  );
  assert.equal(element.opacity, 60);
  assert.equal(element.y, 80);
});
