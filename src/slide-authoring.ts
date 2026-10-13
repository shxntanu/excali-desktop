import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { type Slide } from "./presentation";

// A slide is an encapsulated set: regenerate its object/group ids and keep internal bindings.
export function duplicateSlideElements(
  slide: Slide<ExcalidrawElement>,
  dx: number,
  dy: number,
  newId: () => string = () => crypto.randomUUID(),
): ExcalidrawElement[] {
  const source = [slide.frame, ...slide.elements];
  const ids = new Map(source.map((element) => [element.id, newId()]));
  const groups = new Map<string, string>();
  return structuredClone(source).map((element) => {
    element = {
      ...element,
      id: ids.get(element.id)!,
      x: element.x + dx,
      y: element.y + dy,
      index: null,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
      frameId: element.frameId ? (ids.get(element.frameId) ?? null) : null,
      groupIds: element.groupIds.map((id) => {
        if (!groups.has(id)) groups.set(id, newId());
        return groups.get(id)!;
      }),
      boundElements:
        element.boundElements?.flatMap((bound) =>
          ids.has(bound.id) ? [{ ...bound, id: ids.get(bound.id)! }] : [],
        ) ?? null,
    };
    if ("containerId" in element)
      element = {
        ...element,
        containerId: element.containerId
          ? (ids.get(element.containerId) ?? null)
          : null,
      };
    if ("startBinding" in element) {
      const linear = element;
      const remap = (binding: typeof linear.startBinding) =>
        binding && ids.has(binding.elementId)
          ? { ...binding, elementId: ids.get(binding.elementId)! }
          : null;
      element = {
        ...element,
        startBinding: remap(element.startBinding),
        endBinding: remap(element.endBinding),
      };
    }
    return element;
  });
}
