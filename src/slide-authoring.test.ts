import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { duplicateSlideElements } from "./slide-authoring";
import { getSlides } from "./presentation";

test("slide duplication remaps frames, text, groups and arrows, preserving builds and styles", () => {
  const base = {
    x: 100,
    y: 200,
    width: 1600,
    height: 900,
    version: 1,
    isDeleted: false,
    frameId: null,
    groupIds: [],
    boundElements: null,
  };
  const source = [
    {
      ...base,
      id: "frame",
      type: "frame",
      name: "Architecture",
      customData: {
        slide: { transition: "dissolve", duration: 450, aspectRatio: 16 / 9 },
      },
    },
    {
      ...base,
      id: "box",
      type: "rectangle",
      frameId: "frame",
      groupIds: ["group"],
      boundElements: [
        { id: "text", type: "text" },
        { id: "arrow", type: "arrow" },
      ],
      customData: { build: { step: 3, effect: "rise" } },
    },
    {
      ...base,
      id: "text",
      type: "text",
      frameId: "frame",
      containerId: "box",
      groupIds: ["group"],
      text: "API server",
    },
    {
      ...base,
      id: "arrow",
      type: "arrow",
      frameId: "frame",
      startBinding: { elementId: "box", focus: 0, gap: 4 },
      endBinding: { elementId: "outside", focus: 0, gap: 4 },
    },
  ] as unknown as ExcalidrawElement[];
  const before = JSON.stringify(source);
  let id = 0;
  const copies = duplicateSlideElements(
    getSlides(source)[0],
    2000,
    20,
    () => `new-${++id}`,
  );
  const [frame, box, text, arrow] = copies as any[];
  assert.equal(frame.x, 2100);
  assert.equal(frame.width, 1600);
  assert.equal(box.frameId, frame.id);
  assert.equal(text.containerId, box.id);
  assert.equal(box.boundElements[0].id, text.id);
  assert.equal(arrow.startBinding.elementId, box.id);
  assert.equal(arrow.endBinding, null);
  assert.deepEqual(box.groupIds, text.groupIds);
  assert.notEqual(box.groupIds[0], "group");
  assert.deepEqual(box.customData.build, { step: 3, effect: "rise" });
  assert.equal(getSlides(copies)[0].settings.transition, "dissolve");
  assert.equal(getSlides(copies)[0].ranks.get(text.id), 1);
  assert.equal(JSON.stringify(source), before);
});

import { layoutElements, safeArea } from "./slide-authoring";

test("layout starters scale to the frame and keep diagram references internal", () => {
  assert.deepEqual(
    layoutElements("blank", { x: 100, y: 200, width: 1600, height: 900 }),
    [],
  );
  for (const width of [1200, 1600]) {
    const frame = { x: 100, y: 200, width, height: 900 };
    const area = safeArea(frame);
    for (const layout of ["title", "columns", "diagram"] as const) {
      const elements = layoutElements(layout, frame);
      assert.ok(elements.length >= 2);
      assert.ok(
        elements.every(
          (element) => element.x! >= area.x && element.y! >= area.y,
        ),
      );
      assert.ok(
        elements.every(
          (element) => element.x! + (element.width ?? 0) <= area.x + area.width,
        ),
      );
      assert.ok(
        elements.every(
          (element) =>
            element.y! + (element.height ?? 0) <= area.y + area.height,
        ),
      );
      assert.equal(elements[0].type, "text");
    }
    const diagram = layoutElements("diagram", frame) as any[];
    const arrow = diagram.find((element) => element.type === "arrow");
    assert.equal(arrow.start.id, diagram[1].id);
    assert.equal(arrow.end.id, diagram[2].id);
  }
});
