import { z } from "zod";

const id = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-1e7).max(1e7);
// Excalidraw owns the remaining style/binding fields; reject unsafe or unsupported element kinds.
export const elementSchema = z
  .looseObject({
    type: z.enum([
      "rectangle",
      "ellipse",
      "diamond",
      "text",
      "arrow",
      "line",
      "freedraw",
      "image",
      "frame",
      "magicframe",
    ]),
    id: id.optional(),
    x: coordinate,
    y: coordinate,
    width: coordinate.optional(),
    height: coordinate.optional(),
    angle: z.number().finite().optional(),
    opacity: z.number().min(0).max(100).optional(),
    strokeWidth: z.number().min(0).max(100).optional(),
    frameId: z.string().nullable().optional(),
    points: z
      .array(z.tuple([coordinate, coordinate]))
      .max(10000)
      .optional(),
    customData: z.record(z.string(), z.any()).optional(),
    children: z.array(id).optional(),
    text: z.string().max(100_000).optional(),
    fontSize: z.number().positive().max(1000).optional(),
    label: z
      .looseObject({
        text: z.string().max(100_000),
        fontSize: z.number().positive().max(1000).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "text" && typeof value.text !== "string")
      ctx.addIssue({ code: "custom", message: "Text elements require text" });
    if (value.type === "image" && typeof value.fileId !== "string")
      ctx.addIssue({
        code: "custom",
        message: "Image elements require fileId",
      });
  });
export const settingsSchema = z.object({
  order: z.number().finite().nullable().optional(),
  hidden: z.boolean().optional(),
  transition: z.enum(["move", "dissolve", "cut"]).optional(),
  duration: z.number().min(0).max(5000).optional(),
});
export const buildSchema = z.object({
  step: z.number().int().positive(),
  effect: z.enum(["fade", "rise", "appear"]).default("fade"),
});
export const slidesSchema = z
  .array(
    z.object({
      title: z.string().max(1000),
      width: z.number().positive().max(10000).default(1280),
      height: z.number().positive().max(10000).default(720),
      settings: settingsSchema.optional(),
      elements: z.array(elementSchema).max(2000).default([]),
    }),
  )
  .min(1)
  .max(100);
export type SlideInput = z.infer<typeof slidesSchema>[number];

export function parseElements(text: string): Record<string, any>[] {
  if (text.length > 5 * 1024 * 1024)
    throw new Error("Elements exceed the 5 MB limit");
  const values = z
    .array(z.record(z.string(), z.any()))
    .max(10000)
    .parse(JSON.parse(text));
  const ids = new Set<string>();
  for (const value of values) {
    if (value.type === "restoreCheckpoint") z.object({ id }).parse(value);
    else if (value.type === "delete")
      z.object({ ids: z.string().min(1) }).parse(value);
    else if (value.type === "cameraUpdate")
      z.object({
        x: coordinate,
        y: coordinate,
        width: z.number().positive(),
        height: z.number().positive(),
      }).parse(value);
    else {
      elementSchema.parse(value);
      // Official arrows may use signed width/height; points determine the final bounds.
      if (value.id) {
        if (ids.has(value.id))
          throw new Error(`Duplicate element id: ${value.id}`);
        ids.add(value.id);
      }
    }
  }
  if (values.filter((v) => v.type === "restoreCheckpoint").length > 1)
    throw new Error("Use only one restoreCheckpoint");
  return values;
}

export function slideSkeletons(slides: SlideInput[], offset = 0, startX = 0) {
  const ids = new Set<string>();
  for (const slide of slides)
    for (const element of slide.elements) {
      if (element.id && ids.has(element.id))
        throw new Error(`Duplicate slide element id: ${element.id}`);
      if (element.id) ids.add(element.id);
    }
  let nextX = startX;
  return slides.flatMap((slide, index) => {
    const frameId = crypto.randomUUID();
    const x = nextX;
    nextX += slide.width + 120;
    const members = [
      {
        type: "text",
        id: crypto.randomUUID(),
        x: x + 64,
        y: 48,
        text: slide.title,
        fontSize: 40,
        frameId,
      },
      ...slide.elements.map((element) => ({
        ...element,
        id: element.id ?? crypto.randomUUID(),
        x: x + element.x,
        frameId,
      })),
    ];
    return [
      ...members,
      {
        type: "frame",
        id: frameId,
        x,
        y: 0,
        width: slide.width,
        height: slide.height,
        name: slide.title,
        children: members.map((element) => element.id),
        customData: {
          slide: {
            order: offset + index,
            hidden: false,
            transition: "move",
            duration: 800,
            ...slide.settings,
          },
        },
      },
    ];
  });
}

export const filesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      mimeType: z.enum([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
      ]),
      dataURL: z
        .string()
        .max(10 * 1024 * 1024)
        .regex(
          /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/,
        ),
      created: z.number().finite().optional(),
    }),
  )
  .max(100);
