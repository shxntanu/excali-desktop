import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./icons";
import {
  advance,
  aspectOf,
  BUILD_DURATION,
  cameraPath,
  easeInOut,
  easeOut,
  fit,
  fitRect,
  getSlides,
  hiddenAt,
  lerpBounds,
  playlist,
  progress,
  type Bounds,
  type Camera,
  type Position,
  type Size,
  type Slide,
} from "./presentation";
import { desktop } from "./storage";

type Props = {
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  background: string;
  theme: "light" | "dark";
  // The frame to start on; null starts at the first slide.
  start: string | null;
  // Receives the frame of the slide that was showing.
  onExit: (frameId: string) => void;
};

type Blank = "black" | "white" | null;

const frameRendering = {
  enabled: true,
  name: false,
  outline: false,
  clip: true,
};
// How far, in screen pixels, a rising build travels.
const RISE = 28;
const IDLE_AFTER = 2200;
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const boundsOf = (slide: Slide): Bounds => ({
  x: slide.frame.x,
  y: slide.frame.y,
  width: slide.frame.width,
  height: slide.frame.height,
});

export default function Presenter({
  elements,
  files,
  background,
  theme,
  start,
  onExit,
}: Props) {
  // A copy, so animating the presentation never touches the drawing being edited.
  const [scene] = useState(() => {
    const base = structuredClone(elements) as ExcalidrawElement[];
    const slides = playlist(getSlides(base), start);
    const first = Math.max(
      0,
      slides.findIndex((slide) => slide.frame.id === start),
    );
    return { base, slides, first: { slide: first, step: 0 } as Position };
  });
  const { base, slides } = scene;
  const [position, setPosition] = useState(scene.first);
  const [size, setSize] = useState<Size | null>(null);
  const [laser, setLaser] = useState(false);
  const [blank, setBlank] = useState<Blank>(null);
  const [help, setHelp] = useState(false);
  const [idle, setIdle] = useState(false);
  const [jump, setJump] = useState("");

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mask = useRef<HTMLDivElement>(null);
  const snapshot = useRef<HTMLCanvasElement>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const loaded = useRef(false);
  const initial = useRef<ExcalidrawInitialDataState | null>(null);
  // Playback state is read by animation frames, so it lives outside React state.
  const pos = useRef(scene.first);
  const view = useRef<Size>({ width: 0, height: 0 });
  const camera = useRef<Camera>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const hidden = useRef(hiddenAt(slides, scene.first));
  const building = useRef(new Map<string, { opacity: number; dy: number }>());
  const hiddenCopies = useRef(new Map<string, ExcalidrawElement>());
  const animation = useRef<{ finish: () => void } | null>(null);
  const keydown = useRef((_event: KeyboardEvent) => {});
  const exitRef = useRef(() => {});
  const lastMove = useRef(performance.now());
  // Stable, so Excalidraw doesn't re-render whenever the controls do.
  const onApi = useCallback((value: ExcalidrawImperativeAPI) => {
    api.current = value;
  }, []);
  // Excalidraw reports its first change once the scene has loaded.
  const onLoad = useCallback(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.current?.updateFrameRendering(frameRendering);
    settle();
    paint(true);
  }, []);

  function compose() {
    return base.map((element) => {
      const build = building.current.get(element.id);
      if (build)
        return newElementWith(
          element,
          { opacity: element.opacity * build.opacity, y: element.y + build.dy },
          true,
        );
      if (!hidden.current.has(element.id)) return element;
      let copy = hiddenCopies.current.get(element.id);
      if (!copy)
        hiddenCopies.current.set(
          element.id,
          (copy = newElementWith(element, { opacity: 0 })),
        );
      return copy;
    });
  }

  function cameraState() {
    const { scrollX, scrollY, zoom } = camera.current;
    return { scrollX, scrollY, zoom: { value: zoom } as AppState["zoom"] };
  }

  function paint(withElements: boolean) {
    if (!api.current || !loaded.current) return;
    api.current.updateScene({
      ...(withElements ? { elements: compose() } : {}),
      appState: cameraState(),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  function setMask(rect: Bounds, opacity = 1) {
    const style = mask.current?.style;
    if (!style) return;
    style.left = `${Math.round(rect.x)}px`;
    style.top = `${Math.round(rect.y)}px`;
    style.width = `${Math.round(rect.width)}px`;
    style.height = `${Math.round(rect.height)}px`;
    style.opacity = String(opacity);
  }

  const slideRect = (slide: Slide) =>
    fitRect(aspectOf(boundsOf(slide)), view.current);

  // Snaps the camera and mask to the current slide.
  function settle() {
    const slide = slides[pos.current.slide];
    camera.current = fit(boundsOf(slide), view.current);
    setMask(slideRect(slide));
  }

  function animate(
    duration: number,
    update: (t: number) => void,
    done: () => void,
  ) {
    const begin = performance.now();
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      animation.current = null;
      done();
    };
    const tick = (now: number) => {
      const t = (now - begin) / duration;
      if (t >= 1) return finish();
      update(t);
      frame = requestAnimationFrame(tick);
    };
    animation.current = { finish };
    frame = requestAnimationFrame(tick);
  }

  function hideSnapshot() {
    if (snapshot.current) snapshot.current.hidden = true;
  }

  // Freezes what is on screen, letterbox included, so the next slide can dissolve in underneath it.
  function takeSnapshot(rect: Bounds) {
    const canvas = snapshot.current;
    const source = stage.current?.querySelector<HTMLCanvasElement>(
      "canvas.excalidraw__canvas.static",
    );
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const { width, height } = view.current;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (source) {
      context.save();
      context.beginPath();
      context.rect(
        Math.round(rect.x) * ratio,
        Math.round(rect.y) * ratio,
        Math.round(rect.width) * ratio,
        Math.round(rect.height) * ratio,
      );
      context.clip();
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      context.restore();
    }
    canvas.style.opacity = "1";
    canvas.hidden = false;
  }

  function build(next: Position) {
    const slide = slides[next.slide];
    hidden.current = hiddenAt(slides, next);
    const entering = [...slide.ranks]
      .filter(
        ([id, rank]) =>
          rank === next.step && slide.effects.get(id) !== "appear",
      )
      .map(([id]) => id);
    if (!entering.length) return paint(true);
    const zoom = camera.current.zoom;
    animate(
      BUILD_DURATION,
      (t) => {
        const eased = easeOut(t);
        for (const id of entering)
          building.current.set(id, {
            opacity: eased,
            dy:
              slide.effects.get(id) === "rise"
                ? ((1 - eased) * RISE) / zoom
                : 0,
          });
        paint(true);
      },
      () => {
        building.current.clear();
        paint(true);
      },
    );
  }

  function transition(previous: Position, next: Position) {
    const from = slides[previous.slide],
      to = slides[next.slide];
    // A slide's transition is how it comes in; going back plays the one of the slide being left.
    const { transition: kind, duration } = (
      next.slide > previous.slide ? to : from
    ).settings;
    const final = hiddenAt(slides, next);
    const fromRect = slideRect(from),
      toRect = slideRect(to);
    const target = fit(boundsOf(to), view.current);
    const land = () => {
      hidden.current = final;
      settle();
      paint(true);
    };
    if (kind === "cut" || duration === 0 || reducedMotion()) return land();
    if (kind === "dissolve") {
      takeSnapshot(fromRect);
      land();
      return animate(
        duration,
        (t) => {
          if (snapshot.current)
            snapshot.current.style.opacity = String(1 - easeInOut(t));
        },
        hideSnapshot,
      );
    }
    // The slide being left keeps its builds until the camera has moved off it.
    const leaving = new Set(from.ranks.keys());
    hidden.current = new Set(
      [...final]
        .filter((id) => !leaving.has(id))
        .concat([...hidden.current].filter((id) => leaving.has(id))),
    );
    paint(true);
    const path = cameraPath(camera.current, target, view.current);
    animate(
      duration,
      (t) => {
        const eased = easeInOut(t);
        camera.current = path(eased);
        // The letterbox opens up in flight so the canvas between slides is visible.
        setMask(
          lerpBounds(fromRect, toRect, eased),
          1 - Math.sin(Math.PI * eased),
        );
        paint(false);
      },
      land,
    );
  }

  function go(next: Position | null) {
    if (!next || !loaded.current) return;
    animation.current?.finish();
    const previous = pos.current;
    if (next.slide === previous.slide && next.step === previous.step) return;
    pos.current = next;
    setPosition(next);
    if (next.slide !== previous.slide) return transition(previous, next);
    if (next.step === previous.step + 1 && !reducedMotion()) return build(next);
    hidden.current = hiddenAt(slides, next);
    paint(true);
  }

  const step = (direction: 1 | -1) =>
    go(advance(slides, pos.current, direction));
  // Whole slides at a time; going back still lands on a fully built slide.
  const skip = (direction: 1 | -1) => {
    const slide = pos.current.slide + direction;
    if (slide < 0 || slide >= slides.length) return;
    go({ slide, step: direction > 0 ? 0 : slides[slide].steps.length });
  };
  const last = () =>
    go({ slide: slides.length - 1, step: slides.at(-1)!.steps.length });

  function exit() {
    animation.current?.finish();
    onExit(slides[pos.current.slide].frame.id);
  }
  exitRef.current = exit;

  function toggleLaser(on = !laser) {
    setLaser(on);
    api.current?.setActiveTool({ type: on ? "laser" : "selection" });
  }

  keydown.current = (event) => {
    // The editors and Excalidraw's own shortcuts stay out of the presentation.
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const { key } = event;
    const handled = () => event.preventDefault();
    if (help) {
      if (key === "Escape" || key === "?" || key === "/") {
        handled();
        setHelp(false);
      }
      return;
    }
    if (blank) {
      handled();
      if (!["Shift", "Meta", "Control", "Alt"].includes(key)) setBlank(null);
      return;
    }
    if (/^[0-9]$/.test(key)) {
      handled();
      setJump((value) => (value + key).slice(-4));
      return;
    }
    if (key === "Enter" && jump) {
      handled();
      const slide = Number(jump) - 1;
      setJump("");
      if (slide >= 0 && slide < slides.length) go({ slide, step: 0 });
      return;
    }
    if (jump && (key === "Escape" || key === "Backspace")) {
      handled();
      setJump("");
      return;
    }
    switch (key) {
      case "ArrowRight":
      case "ArrowDown":
        handled();
        return event.shiftKey ? skip(1) : step(1);
      case "ArrowLeft":
      case "ArrowUp":
        handled();
        return event.shiftKey ? skip(-1) : step(-1);
      case " ":
      case "Enter":
      case "PageDown":
      case "n":
      case "N":
        handled();
        return step(event.shiftKey && key === " " ? -1 : 1);
      case "PageUp":
      case "Backspace":
      case "p":
      case "P":
        handled();
        return step(-1);
      case "Home":
        handled();
        return go({ slide: 0, step: 0 });
      case "End":
        handled();
        return last();
      case "l":
      case "L":
        handled();
        return toggleLaser();
      case "b":
      case "B":
      case ".":
        handled();
        return setBlank("black");
      case "w":
      case "W":
      case ",":
        handled();
        return setBlank("white");
      case "?":
      case "/":
        handled();
        return setHelp(true);
      case "Escape":
        handled();
        if (laser) return toggleLaser(false);
        return exit();
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydown.current(event);
    // Trackpad pinches and scrolls would otherwise move the camera off the slide.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const element = root.current!;
    window.addEventListener("keydown", listener, true);
    element.addEventListener("wheel", wheel, { capture: true, passive: false });
    element.focus();
    return () => {
      animation.current?.finish();
      window.removeEventListener("keydown", listener, true);
      element.removeEventListener("wheel", wheel, true);
    };
  }, []);

  useEffect(() => {
    const element = stage.current!;
    const observer = new ResizeObserver(() => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (!next.width || !next.height) return;
      view.current = next;
      animation.current?.finish();
      settle();
      paint(false);
      setSize((value) => value ?? next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    // A window that can't go fullscreen still presents, just in the window.
    if (desktop) {
      const win = getCurrentWindow();
      let entered = false;
      void win
        .isFullscreen()
        .then(async (full) => {
          if (full || disposed) return;
          await win.setFullscreen(true);
          entered = true;
          if (disposed) await win.setFullscreen(false);
        })
        .catch(() => {});
      return () => {
        disposed = true;
        if (entered) void win.setFullscreen(false).catch(() => {});
      };
    }
    // In the browser, leaving fullscreen with Escape never reaches the page, so it ends the presentation.
    const change = () => {
      if (!document.fullscreenElement) exitRef.current();
    };
    void root.current
      ?.requestFullscreen?.()
      .then(() => {
        if (disposed) return;
        document.addEventListener("fullscreenchange", change);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      document.removeEventListener("fullscreenchange", change);
      if (document.fullscreenElement)
        void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (idle || help) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const wait = lastMove.current + IDLE_AFTER - performance.now();
      if (wait <= 0) setIdle(true);
      else timer = setTimeout(check, wait);
    };
    timer = setTimeout(check, IDLE_AFTER);
    return () => clearTimeout(timer);
  }, [idle, help]);

  if (size && !initial.current) {
    initial.current = {
      elements: compose(),
      files,
      appState: {
        viewBackgroundColor: background,
        frameRendering,
        ...cameraState(),
      },
    };
  }

  const current = slides[position.slide];
  const atEnd = !advance(slides, position, 1);
  return (
    <div
      ref={root}
      className={`presenter ${idle && !laser ? "idle" : ""} ${laser ? "laser" : ""}`}
      tabIndex={-1}
      role="application"
      aria-roledescription="presentation"
      aria-label={`Slide ${position.slide + 1} of ${slides.length}`}
      onPointerMove={() => {
        lastMove.current = performance.now();
        if (idle) setIdle(false);
      }}
    >
      <div ref={stage} className="presenter-stage">
        {size && initial.current && (
          <Excalidraw
            initialData={initial.current}
            theme={theme}
            viewModeEnabled
            zenModeEnabled
            excalidrawAPI={onApi}
            onChange={onLoad}
          />
        )}
      </div>
      <div ref={mask} className="presenter-mask" />
      <canvas ref={snapshot} className="presenter-snapshot" hidden />
      <div
        className="presenter-input"
        onClick={() => step(1)}
        onContextMenu={(event) => {
          event.preventDefault();
          step(-1);
        }}
      />
      {blank && (
        <div
          className={`presenter-blank ${blank}`}
          onClick={() => setBlank(null)}
        />
      )}
      {jump && (
        <div className="presenter-jump" role="status">
          Slide {jump}
        </div>
      )}
      <div
        className="presenter-controls"
        role="toolbar"
        aria-label="Presentation controls"
      >
        <button
          onClick={() => step(-1)}
          disabled={position.slide === 0 && position.step === 0}
          aria-label="Previous"
          title="Previous (←)"
        >
          <Icon name="previous" />
        </button>
        <span className="presenter-counter" aria-live="polite">
          {position.slide + 1} / {slides.length}
          {current.steps.length > 0 && (
            <span
              className="presenter-steps"
              aria-label={`Build ${position.step} of ${current.steps.length}`}
            >
              {current.steps.map((_, index) => (
                <i
                  key={index}
                  className={index < position.step ? "done" : ""}
                />
              ))}
            </span>
          )}
        </span>
        <button
          onClick={() => step(1)}
          disabled={atEnd}
          aria-label="Next"
          title="Next (→)"
        >
          <Icon name="next" />
        </button>
        <span className="presenter-divider" />
        <button
          onClick={() => toggleLaser()}
          aria-pressed={laser}
          aria-label="Laser pointer"
          title="Laser pointer (L)"
        >
          <Icon name="laser" />
        </button>
        <button
          onClick={() => setHelp(!help)}
          aria-pressed={help}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <Icon name="keyboard" />
        </button>
        <button
          onClick={exit}
          aria-label="End presentation"
          title="End presentation (Esc)"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="presenter-progress" aria-hidden="true">
        <div style={{ transform: `scaleX(${progress(slides, position)})` }} />
      </div>
      {help && (
        <div
          className="presenter-help"
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <dl>
            <dt>→ Space Enter</dt>
            <dd>Next build or slide</dd>
            <dt>← Backspace</dt>
            <dd>Previous</dd>
            <dt>⇧→ ⇧←</dt>
            <dd>Next or previous slide</dd>
            <dt>Home End</dt>
            <dd>First or last slide</dd>
            <dt>Number, Enter</dt>
            <dd>Go to slide</dd>
            <dt>L</dt>
            <dd>Laser pointer</dd>
            <dt>B W</dt>
            <dd>Black or white screen</dd>
            <dt>Esc</dt>
            <dd>End presentation</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
