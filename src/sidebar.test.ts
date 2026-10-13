import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canDrop, orderedEntries, placeEntry, remapOrder } from "./sidebar";
import type { Entry } from "./storage";

const file = (path: string): Entry => ({ path, name: path.split("/").at(-1)!, folder: false, children: [] });
const nested: Entry = { ...file("/root/folder"), folder: true, children: [file("/root/folder/c"), file("/root/folder/d")] };
const entries = [nested, file("/root/a"), file("/root/b")];

test("sidebar order survives refresh, reorders in both directions, and leaves new files visible", () => {
  let order = placeEntry({}, entries, "/root/b", "/root/b", { path: "/root/a", position: "before" });
  assert.deepEqual(orderedEntries(entries, order).map((entry) => entry.path), ["/root/folder", "/root/b", "/root/a"]);
  order = placeEntry(order, entries, "/root/b", "/root/b", { path: "/root/a", position: "after" });
  assert.deepEqual(orderedEntries([...entries, file("/root/new")], JSON.parse(JSON.stringify(order))).map((entry) => entry.path), ["/root/folder", "/root/a", "/root/b", "/root/new"]);
});

test("moving into folders, out to root, and renaming preserves nested ordering", () => {
  const order = placeEntry({}, entries, "/root/folder/d", "/root/folder/d", { path: "/root/folder/c", position: "before" });
  const moved = placeEntry(order, entries, "/root/a", "/root/folder/a", { path: "/root/folder", position: "inside" });
  assert.deepEqual(moved["/root/folder"], ["/root/folder/d", "/root/folder/c", "/root/folder/a"]);
  const renamed = remapOrder(moved, "/root/folder", "/root/renamed");
  assert.deepEqual(renamed["/root/renamed"], ["/root/renamed/d", "/root/renamed/c", "/root/renamed/a"]);
  const outside = placeEntry(order, entries, "/root/folder/d", "/root/d", { path: "/root", position: "inside" });
  assert.deepEqual(outside["/root/folder"], ["/root/folder/c"]);
  assert.deepEqual(outside["/root"], ["/root/folder", "/root/a", "/root/b", "/root/d"]);
  assert.equal(canDrop(nested, { path: "/root/folder/c", position: "before" }), false);
  assert.equal(canDrop(nested, { path: nested.path, position: "inside" }), false);
  assert.equal(canDrop(nested, { path: "/root/folderish", position: "inside" }), true);
});
