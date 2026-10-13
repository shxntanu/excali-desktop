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

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { Bounds } from "./presentation";

export const slideLayouts = [
  { value: "blank", label: "Blank" },
  { value: "title", label: "Title + content" },
  { value: "columns", label: "Two columns" },
  { value: "diagram", label: "Diagram + caption" },
] as const;
export type SlideLayout = (typeof slideLayouts)[number]["value"];

export function safeArea(frame: Bounds): Bounds {
  const inset = Math.min(frame.width, frame.height) * 0.06;
  return {
    x: frame.x + inset,
    y: frame.y + inset,
    width: frame.width - inset * 2,
    height: frame.height - inset * 2,
  };
}

// Starters contain only ordinary text, shapes and an arrow; everything remains editable.
export function layoutElements(
  layout: SlideLayout,
  frame: Bounds,
): ExcalidrawElementSkeleton[] {
  if (layout === "blank") return [];
  const area = safeArea(frame);
  const scale = Math.min(frame.width / 1600, frame.height / 900);
  const text = (
    value: string,
    x: number,
    y: number,
    fontSize = 28,
  ): ExcalidrawElementSkeleton => ({
    type: "text",
    text: value,
    x,
    y,
    fontSize: fontSize * scale,
    fontFamily: 5,
  });
  const title = text("Slide title", area.x, area.y, 52);
  const y = area.y + frame.height * 0.22;
  if (layout === "title")
    return [
      title,
      text(
        "Add your key points here\n• First point\n• Second point\n• Third point",
        area.x,
        y,
      ),
    ];
  if (layout === "columns")
    return [
      title,
      text("First topic", area.x, y, 34),
      text("Add your content here", area.x, y + frame.height * 0.12),
      text("Second topic", area.x + area.width * 0.53, y, 34),
      text(
        "Add your content here",
        area.x + area.width * 0.53,
        y + frame.height * 0.12,
      ),
    ];
  const start = crypto.randomUUID(),
    end = crypto.randomUUID();
  const boxWidth = area.width * 0.3,
    boxHeight = frame.height * 0.23;
  const firstX = area.x + area.width * 0.08,
    secondX = area.x + area.width * 0.62;
  const boxY = area.y + frame.height * 0.3;
  return [
    title,
    {
      type: "rectangle",
      id: start,
      x: firstX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      label: { text: "Start", fontSize: 30 * scale, fontFamily: 5 },
    },
    {
      type: "rectangle",
      id: end,
      x: secondX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      label: { text: "Next", fontSize: 30 * scale, fontFamily: 5 },
    },
    {
      type: "arrow",
      x: firstX + boxWidth,
      y: boxY + boxHeight / 2,
      width: secondX - firstX - boxWidth,
      height: 0,
      start: { id: start },
      end: { id: end },
    },
    text(
      "Add a caption for your diagram",
      area.x,
      area.y + frame.height * 0.76,
      24,
    ),
  ];
}
