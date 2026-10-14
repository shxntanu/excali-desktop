import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createWriteQueue, fileName, restoreSession, serializeRecovery, validateDrawing } from "./document.ts";

test("startup reopens the last saved drawing and prefers recovered edits in the selected tab", async () => {
  const drawing = '{"type":"excalidraw","elements":[]}';
  const path = "/drawings/architecture.excalidraw";
  const errors: unknown[] = [];
  const read = async (requested: string) => {
    assert.equal(requested, path);
    return drawing;
  };
  const saved = await restoreSession(null, path, read, (error) => errors.push(error));
  assert.equal(saved.documents[saved.activeIndex].path, path);
  assert.equal(saved.documents[0].dirty, false);

  const inactiveRecovery = serializeRecovery([{ name: "Untitled", drawing }]);
  const selectedSaved = await restoreSession(inactiveRecovery, path, read, (error) => errors.push(error));
  assert.equal(selectedSaved.activeIndex, 1);
  assert.equal(selectedSaved.documents[1].path, path);

  const recovery = serializeRecovery([
    { name: "architecture", path, drawing },
    { name: "Untitled", path: null, drawing, active: true },
  ]);
  const restored = await restoreSession(recovery, path, async () => {
    assert.fail("must not replace recovered edits with the saved file");
  }, (error) => errors.push(error));
  assert.equal(restored.documents.length, 2);
  assert.equal(restored.activeIndex, 1);
  assert.equal(restored.documents[0].dirty, true);
  assert.equal(restored.documents[1].path, null);

  const legacy = JSON.stringify({ name: "Untitled", drawing });
  const missing = await restoreSession(legacy, path, async () => { throw new Error("file removed"); }, (error) => errors.push(error));
  assert.equal(missing.documents.length, 1);
  assert.equal(missing.documents[0].dirty, true);
  assert.equal(errors.length, 1);

  const corrupt = await restoreSession("invalid recovery", path, read, (error) => errors.push(error));
  assert.equal(corrupt.documents[0].path, path);
  assert.equal(errors.length, 2);
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
