import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createWriteQueue, fileName, validateDrawing } from "./document.ts";
import { cssFamily, fontId, lineHeight } from "./fonts.ts";

test("system fonts get stable ids clear of Excalidraw's own and valid CSS names", () => {
  assert.equal(fontId("Avenir Next"), fontId("Avenir Next"));
  assert.notEqual(fontId("Avenir Next"), fontId("Avenir"));
  assert.ok(fontId("") >= 10_000);
  assert.equal(cssFamily('Odd "Name" \\ 3D'), '"Odd \\"Name\\" \\\\ 3D"');
  // Excalifont's and Nunito's own metrics give Excalidraw's line heights for them.
  assert.equal(lineHeight({ family: "Excalifont", unitsPerEm: 1000, ascender: 886, descender: -374 }), 1.25);
  assert.equal(lineHeight({ family: "Nunito", unitsPerEm: 1000, ascender: 1011, descender: -353 }), 1.35);
});

test("rejects unrelated JSON without accepting it as a drawing", () => {
  assert.throws(() => validateDrawing('{"elements":[]}'));
  assert.throws(() => validateDrawing('{"type":"excalidraw","elements":null}'));
  assert.throws(() => validateDrawing("invalid"));
  validateDrawing('{"type":"excalidraw","elements":[],"files":{}}');
  assert.equal(fileName("C:\\drawings\\ideas.excalidraw"), "ideas.excalidraw");
});

test("recovery writes cannot overtake one another and recover after errors", async () => {
  const queue = createWriteQueue();
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = queue(async () => { await blocked; calls.push("old recovery"); });
  const second = queue(async () => { calls.push("remove recovery"); });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["old recovery", "remove recovery"]);
  await assert.rejects(queue(async () => { throw new Error("disk full"); }));
  await queue(async () => { calls.push("new recovery"); });
  assert.equal(calls.at(-1), "new recovery");
});
