import {
  convertToExcalidrawElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { elementSchema, parseElements } from "./mcp-schema";

// Convert the official compact element format using Excalidraw's own constructors.
export function convert(
  elements: Record<string, any>[],
): OrderedExcalidrawElement[] {
  const skeletons = elements.map((element) => {
    const next = { ...element };
    if (next.type === "frame" || next.type === "magicframe")
      next.children ??= elements
        .filter((e) => e.frameId === next.id)
        .map((e) => e.id);
    if (next.type === "arrow") {
      // The official MCP uses bindings; Excalidraw's constructor uses start/end references.
      if (next.startBinding?.elementId)
        next.start = { id: next.startBinding.elementId };
      if (next.endBinding?.elementId)
        next.end = { id: next.endBinding.elementId };
    }
    return next;
  });
  const result = convertToExcalidrawElements(
    skeletons as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );
  const byId = new Map(elements.map((e) => [e.id, e]));
  // Bound labels inherit the container's frame and build, as the presenter expects.
  return result.map((element) => {
    const source =
      byId.get(element.id) ??
      ("containerId" in element ? byId.get(element.containerId) : undefined);
    return source?.frameId ? { ...element, frameId: source.frameId } : element;
  });
}

export function applyView(
  text: string,
  base: readonly ExcalidrawElement[] = [],
) {
  const input = parseElements(text);
  let elements = restoreElements(base, null);
  let additions: Record<string, any>[] = [];
  let camera:
    | { x: number; y: number; width: number; height: number }
    | undefined;
  const flush = () => {
    if (additions.length) {
      const existing = new Set(elements.map((e) => e.id));
      if (additions.some((e) => e.id && existing.has(e.id)))
        throw new Error(
          "Element id already exists. Use update_elements to patch it.",
        );
      // Include the live scene so new arrows can bind to existing shapes.
      elements = convert([...elements, ...additions]);
      additions = [];
    }
  };
  for (const element of input) {
    if (element.type === "restoreCheckpoint") continue;
    if (element.type === "cameraUpdate") {
      camera = element as typeof camera;
      continue;
    }
    if (element.type === "delete") {
      flush();
      const ids = new Set(
        element.ids.split(",").map((id: string) => id.trim()),
      );
      // Deleting a frame also deletes its slide contents.
      elements = elements.filter(
        (e) =>
          !ids.has(e.id) &&
          !ids.has(e.frameId) &&
          !("containerId" in e && ids.has(e.containerId)),
      );
    } else additions.push(element);
  }
  flush();
  return { elements, camera };
}

export function patchElements(
  elements: readonly ExcalidrawElement[],
  updates: Record<string, any>[],
  deleteIds: string[],
) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const patches = new Map<string, Record<string, any>>();
  for (const update of updates) {
    const existing = byId.get(update.id);
    if (!existing) throw new Error(`Element not found: ${update.id}`);
    if (update.type && update.type !== existing.type)
      throw new Error("An element's type cannot be changed");
    patches.set(update.id, update);
  }
  const deleted = new Set(deleteIds);
  for (const id of deleted)
    if (!byId.has(id)) throw new Error(`Element not found: ${id}`);
  const next = elements.map((element) => {
    const patch = patches.get(element.id);
    const remove =
      deleted.has(element.id) ||
      (element.frameId && deleted.has(element.frameId)) ||
      ("containerId" in element &&
        element.containerId &&
        deleted.has(element.containerId));
    if (!patch && !remove) return element;
    const value = {
      ...element,
      ...patch,
      id: element.id,
      type: element.type,
      isDeleted: !!remove || element.isDeleted,
      version: element.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as ExcalidrawElement;
    for (const key of [
      "x",
      "y",
      "width",
      "height",
      "angle",
      "opacity",
      "strokeWidth",
    ]) {
      if (
        typeof (value as any)[key] !== "number" ||
        !Number.isFinite((value as any)[key])
      )
        throw new Error(`Invalid ${key}`);
    }
    elementSchema.parse(value);
    if (value.type === "text") {
      if (typeof value.text !== "string")
        throw new Error("Text must be a string");
      (value as any).originalText = value.text;
    }
    return value;
  });
  return restoreElements(next, null, {
    repairBindings: true,
    refreshDimensions: true,
  });
}
