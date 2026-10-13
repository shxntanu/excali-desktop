// Slides are frames. Their settings and the build steps of the elements inside them are kept in
// each element's customData, so they are saved with the drawing.

export type Transition = "move" | "dissolve" | "cut";
export type Effect = "fade" | "rise" | "appear";

export type SlideSettings = {
  order: number | null;
  hidden: boolean;
  transition: Transition;
  duration: number;
  aspectRatio: number | null;
};
export type Build = { step: number; effect: Effect };

export const transitions: Transition[] = ["move", "dissolve", "cut"];
export const effects: Effect[] = ["fade", "rise", "appear"];
export const speeds = [
  { label: "Fast", duration: 450 },
  { label: "Normal", duration: 800 },
  { label: "Slow", duration: 1300 },
];
export const BUILD_DURATION = 450;

// The subset of Excalidraw's element type this module needs.
export type SceneElement = {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly isDeleted: boolean;
  readonly frameId: string | null;
  readonly containerId?: string | null;
  readonly customData?: Record<string, any>;
};

export type Slide<T extends SceneElement = SceneElement> = {
  frame: T;
  settings: SlideSettings;
  elements: T[];
  // Distinct build step values in playing order; an element's rank is its position in this list plus one.
  steps: number[];
  ranks: Map<string, number>;
  effects: Map<string, Effect>;
  version: string;
};

export const isFrame = (element: SceneElement) =>
  element.type === "frame" || element.type === "magicframe";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function readSlide(frame: SceneElement): SlideSettings {
  const raw = record(frame.customData?.slide);
  return {
    order: finite(raw.order) ? raw.order : null,
    hidden: raw.hidden === true,
    transition: transitions.includes(raw.transition as Transition)
      ? (raw.transition as Transition)
      : "move",
    duration: finite(raw.duration)
      ? Math.min(Math.max(raw.duration, 0), 5000)
      : 800,
    aspectRatio:
      finite(raw.aspectRatio) && raw.aspectRatio > 0 ? raw.aspectRatio : null,
  };
}

export function readBuild(element: SceneElement | undefined): Build | null {
  const raw = record(element?.customData?.build);
  if (!finite(raw.step) || raw.step <= 0) return null;
  return {
    step: raw.step,
    effect: effects.includes(raw.effect as Effect)
      ? (raw.effect as Effect)
      : "fade",
  };
}

// Returns customData with the slide settings changed, or undefined when nothing is left in it.
export function withSlide(
  customData: Record<string, any> | undefined,
  patch: Partial<SlideSettings>,
) {
  const { slide, ...rest } = customData ?? {};
  const next = { ...record(slide), ...patch };
  return compact({ ...rest, slide: next });
}

export function withBuild(
  customData: Record<string, any> | undefined,
  build: Build | null,
) {
  const { build: _, ...rest } = customData ?? {};
  return compact(build ? { ...rest, build } : rest);
}

function compact(data: Record<string, any>) {
  return Object.keys(data).length ? data : undefined;
}

// Bound text follows its container: it sits in the same frame and is revealed with it.
export function getSlides<T extends SceneElement>(
  elements: readonly T[],
): Slide<T>[] {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const frames = live.flatMap((frame, index) =>
    isFrame(frame) ? [{ frame, index, settings: readSlide(frame) }] : [],
  );
  const children = new Map<string, T[]>(
    frames.map(({ frame }) => [frame.id, []]),
  );
  const container = (element: T) =>
    element.containerId ? byId.get(element.containerId) : undefined;
  for (const element of live) {
    const frameId = element.frameId ?? container(element)?.frameId;
    if (frameId) children.get(frameId)?.push(element);
  }
  frames.sort(
    (a, b) =>
      (a.settings.order ?? Infinity) - (b.settings.order ?? Infinity) ||
      a.index - b.index,
  );
  return frames.map(({ frame, settings }) => {
    const members = children.get(frame.id)!;
    const builds = new Map<string, Build>();
    for (const element of members) {
      const build = readBuild(element) ?? readBuild(container(element));
      if (build) builds.set(element.id, build);
    }
    const steps = [
      ...new Set([...builds.values()].map((build) => build.step)),
    ].sort((a, b) => a - b);
    const ranks = new Map(
      [...builds].map(([id, build]) => [id, steps.indexOf(build.step) + 1]),
    );
    const effects = new Map(
      [...builds].map(([id, build]) => [id, build.effect]),
    );
    const version = [frame, ...members]
      .map((element) => `${element.id}:${element.version}`)
      .join();
    return {
      frame,
      settings,
      elements: members,
      steps,
      ranks,
      effects,
      version,
    };
  });
}

// The slide an element belongs to, by frame or as the frame itself.
export function slideOf<T extends SceneElement>(
  slides: Slide<T>[],
  element: SceneElement,
) {
  return slides.find(
    (slide) =>
      slide.frame.id === element.id ||
      slide.elements.some((member) => member.id === element.id),
  );
}

// The step value for a rank, where the rank after the last one starts a new step.
export function stepForRank(slide: Pick<Slide, "steps">, rank: number) {
  return slide.steps[rank - 1] ?? (slide.steps.at(-1) ?? 0) + 1;
}

export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

// Playing

export type Position = { slide: number; step: number };

// Skipped slides stay out unless the presentation starts on one.
export function playlist<T extends SceneElement>(
  slides: Slide<T>[],
  start: string | null = null,
) {
  const shown = slides.filter(
    (slide) => !slide.settings.hidden || slide.frame.id === start,
  );
  return shown.length ? shown : slides;
}

// Going back lands on the previous slide fully built, as in Keynote.
export function advance(
  slides: readonly Pick<Slide, "steps">[],
  position: Position,
  direction: 1 | -1,
): Position | null {
  const { slide, step } = position;
  if (direction > 0) {
    if (step < slides[slide].steps.length) return { slide, step: step + 1 };
    return slide + 1 < slides.length ? { slide: slide + 1, step: 0 } : null;
  }
  if (step > 0) return { slide, step: step - 1 };
  return slide > 0
    ? { slide: slide - 1, step: slides[slide - 1].steps.length }
    : null;
}

// Earlier slides are fully built and later ones are not built yet, so they look right on the way past.
export function hiddenAt(
  slides: readonly Pick<Slide, "ranks">[],
  position: Position,
) {
  const hidden = new Set<string>();
  slides.forEach((slide, index) => {
    const level =
      index < position.slide
        ? Infinity
        : index === position.slide
          ? position.step
          : 0;
    for (const [id, rank] of slide.ranks) if (rank > level) hidden.add(id);
  });
  return hidden;
}

export function progress(
  slides: readonly Pick<Slide, "steps">[],
  position: Position,
) {
  let done = 0,
    total = 0;
  slides.forEach((slide, index) => {
    const size = slide.steps.length + 1;
    total += size;
    if (index < position.slide) done += size;
    if (index === position.slide) done += position.step + 1;
  });
  return total ? done / total : 0;
}

// Camera

export type Bounds = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
// Excalidraw's viewport: a scene point p appears at (p + scroll) * zoom.
export type Camera = { scrollX: number; scrollY: number; zoom: number };

export function fit(bounds: Bounds, view: Size): Camera {
  const width = Math.max(bounds.width, 1),
    height = Math.max(bounds.height, 1);
  const zoom = Math.min(view.width / width, view.height / height);
  return {
    zoom,
    scrollX: view.width / 2 / zoom - (bounds.x + width / 2),
    scrollY: view.height / 2 / zoom - (bounds.y + height / 2),
  };
}

// Where a slide of the given aspect ratio appears on screen.
export function fitRect(aspect: number, view: Size): Bounds {
  const width = Math.min(view.width, view.height * aspect);
  const height = width / aspect;
  return {
    x: (view.width - width) / 2,
    y: (view.height - height) / 2,
    width,
    height,
  };
}

export const aspectOf = (bounds: Bounds) =>
  Math.max(bounds.width, 1) / Math.max(bounds.height, 1);

export const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

export const lerpBounds = (a: Bounds, b: Bounds, t: number): Bounds => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  width: a.width + (b.width - a.width) * t,
  height: a.height + (b.height - a.height) * t,
});

// Van Wijk and Nuij's smooth zoom-and-pan path: distant slides are reached by zooming out on the way.
// rho sets how far it zooms out; lower values give a flatter path.
export function cameraPath(
  from: Camera,
  to: Camera,
  view: Size,
  rho = 1.2,
): (t: number) => Camera {
  const toView = (camera: Camera) => [
    view.width / 2 / camera.zoom - camera.scrollX,
    view.height / 2 / camera.zoom - camera.scrollY,
    view.width / camera.zoom,
  ];
  const toCamera = (x: number, y: number, width: number): Camera => {
    const zoom = view.width / width;
    return {
      zoom,
      scrollX: view.width / 2 / zoom - x,
      scrollY: view.height / 2 / zoom - y,
    };
  };
  const [ux0, uy0, w0] = toView(from),
    [ux1, uy1, w1] = toView(to);
  const dx = ux1 - ux0,
    dy = uy1 - uy0,
    d1 = Math.hypot(dx, dy);
  if (d1 < 1e-6 * Math.min(w0, w1)) {
    const scale = Math.log(w1 / w0);
    return (t) =>
      toCamera(ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(scale * t));
  }
  const rho2 = rho * rho,
    rho4 = rho2 * rho2,
    d2 = d1 * d1;
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const length = (r1 - r0) / rho;
  const cosh0 = Math.cosh(r0);
  return (t) => {
    if (t >= 1) return to;
    const s = t * length;
    const u =
      (w0 / (rho2 * d1)) * (cosh0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
    return toCamera(
      ux0 + u * dx,
      uy0 + u * dy,
      (w0 * cosh0) / Math.cosh(rho * s + r0),
    );
  };
}

export const slideSizes = [
  { label: "16:9", width: 1600, height: 900 },
  { label: "16:10", width: 1600, height: 1000 },
  { label: "4:3", width: 1200, height: 900 },
];

// Keep the opposite edge anchored when a locked frame is resized from its top or left.
export function lockedFrameBounds(
  previous: Bounds,
  next: Bounds,
  ratio: number,
): Bounds {
  const widthDriven =
    Math.abs(next.width / previous.width - 1) >=
    Math.abs(next.height / previous.height - 1);
  const width = widthDriven ? next.width : next.height * ratio;
  const height = width / ratio;
  return {
    x: next.x === previous.x ? next.x : next.x + next.width - width,
    y: next.y === previous.y ? next.y : next.y + next.height - height,
    width,
    height,
  };
}

// Bound labels are controlled by their container, including when only the label is selected.
export function buildTargets<T extends SceneElement>(
  slide: Slide<T>,
  selected: readonly T[],
): T[] {
  const members = new Map(
    slide.elements.map((element) => [element.id, element]),
  );
  const objects = selected.filter((element) => !isFrame(element));
  if (objects.some((element) => !members.has(element.id))) return [];
  return [
    ...new Map(
      objects.map((element) => {
        const owner =
          (element.containerId && members.get(element.containerId)) || element;
        return [owner.id, owner];
      }),
    ).values(),
  ];
}

export function buildOwners<T extends SceneElement>(
  slide: Slide<T>,
  step: number,
): T[] {
  return slide.elements.filter((element) => readBuild(element)?.step === step);
}

export function reorderBuilds<T extends SceneElement>(
  slide: Slide<T>,
  from: number,
  to: number,
) {
  const order = move(slide.steps, from, to);
  return new Map(
    slide.elements.flatMap((element) => {
      const build = readBuild(element);
      return build
        ? [
            [
              element.id,
              withBuild(element.customData, {
                ...build,
                step: order.indexOf(build.step) + 1,
              }),
            ] as const,
          ]
        : [];
    }),
  );
}

export function buildLabel<T extends SceneElement>(
  slide: Slide<T>,
  element: T,
): string {
  const text = element as T & { text?: string };
  const bound = slide.elements.find(
    (member) => member.containerId === element.id,
  ) as (T & { text?: string }) | undefined;
  return (
    (text.text || bound?.text)?.replace(/\s+/g, " ").trim() ||
    ({
      rectangle: "Rectangle",
      ellipse: "Ellipse",
      diamond: "Diamond",
      arrow: "Arrow",
      line: "Line",
      freedraw: "Drawing",
      image: "Image",
      text: "Text",
      embeddable: "Embed",
    }[element.type] ??
      "Object")
  );
}

// Presentation appearance is computed from copies; the authored opacity and position stay intact.
export function buildAppearance(
  slide: Pick<Slide, "ranks" | "effects">,
  element: SceneElement & { opacity: number },
  step: number,
  progress = 1,
  rise = 28,
) {
  const rank = slide.ranks.get(element.id) ?? 0;
  const effect = slide.effects.get(element.id);
  if (rank > step) return { opacity: 0, y: element.y };
  if (rank > 0 && rank === step && effect !== "appear" && progress < 1) {
    const eased = easeOut(progress);
    return {
      opacity: element.opacity * eased,
      y: element.y + (effect === "rise" ? (1 - eased) * rise : 0),
    };
  }
  return { opacity: element.opacity, y: element.y };
}
