import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToCanvas,
  hashElementsVersion,
  newElementWith,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { Icon } from "./icons";
import {
  effects,
  getSlides,
  isFrame,
  move,
  readBuild,
  slideOf,
  slideSizes,
  speeds,
  stepForRank,
  transitions,
  withBuild,
  withSlide,
  type Effect,
  type Slide,
  type SlideSettings,
} from "./presentation";

const transitionLabels = { move: "Move", dissolve: "Dissolve", cut: "Cut" };
const effectLabels = { fade: "Fade", rise: "Rise", appear: "Appear" };
const DRAG_TYPE = "application/x-excali-slide";

type Scene = {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};
type Play = (start: string | null) => void;

// Lives beside the canvas rather than in an Excalidraw sidebar, which closes on canvas clicks
// whenever the editor is too narrow to dock it; builds are assigned by clicking the canvas.
export function SlidesPanel({
  getApi,
  onPlay,
  onClose,
  onEditorKey,
}: {
  getApi: () => ExcalidrawImperativeAPI | null;
  onPlay: Play;
  onClose: () => void;
  // Excalidraw only hears keys pressed inside it, so undo and redo are passed on.
  onEditorKey: (event: KeyboardEvent) => void;
}) {
  // A new tab's editor may not have handed over its API yet.
  const [api, setApi] = useState(getApi);
  useEffect(() => {
    if (api) return;
    const timer = setInterval(() => setApi(getApi()), 100);
    return () => clearInterval(timer);
  }, [api]);
  return (
    <aside
      className="slides"
      aria-label="Slides"
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (!(event.metaKey || event.ctrlKey) || (key !== "z" && key !== "y")) return;
        if ((event.target as Element).closest("input, select, textarea")) return;
        event.preventDefault();
        onEditorKey(event.nativeEvent);
      }}
    >
      <header className="slides-header">
        <h2>Slides</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Hide slides"
          title="Hide slides"
        >
          <Icon name="close" />
        </button>
      </header>
      {api && <Panel api={api} onPlay={onPlay} />}
    </aside>
  );
}

// Styled with Excalidraw's own trigger classes so it matches the library button beside it.
export function SlidesTrigger({
  open,
  onToggle,
  onPlay,
}: {
  open: boolean;
  onToggle: () => void;
  onPlay: () => void;
}) {
  return (
    <div className="slides-triggers">
      <button
        className={`sidebar-trigger default-sidebar-trigger ${open ? "active" : ""}`}
        onClick={onToggle}
        aria-pressed={open}
        title="Slides"
      >
        <Icon name="slides" size={16} />
        <span className="sidebar-trigger__label">Slides</span>
      </button>
      <button
        className="present-trigger"
        onClick={onPlay}
        title="Present (⇧⌘P)"
        aria-label="Present"
      >
        <Icon name="play" size={16} />
      </button>
    </div>
  );
}

const sceneKey = ({ elements, appState, files }: Scene) =>
  `${hashElementsVersion(elements)}|${Object.keys(appState.selectedElementIds).join()}|${appState.viewBackgroundColor}|${appState.theme}|${Object.keys(files).length}`;

// The panel only mounts while open, so the scene is followed only then.
function Panel({ api, onPlay }: { api: ExcalidrawImperativeAPI; onPlay: Play }) {
  const [scene, setScene] = useState<Scene>(() => ({
    elements: api.getSceneElements(),
    appState: api.getAppState(),
    files: api.getFiles(),
  }));
  useEffect(() => {
    let key = sceneKey(scene);
    return api.onChange((elements, appState, files) => {
      const next = { elements, appState, files };
      const nextKey = sceneKey(next);
      if (nextKey !== key) {
        key = nextKey;
        setScene(next);
      }
    });
  }, [api]);

  const slides = useMemo(() => getSlides(scene.elements), [scene.elements]);
  const selected = useMemo(() => {
    const ids = scene.appState.selectedElementIds;
    return scene.elements.filter(
      (element) => ids[element.id] && !element.isDeleted,
    );
  }, [scene]);
  const frame = selected.find(isFrame);
  const current = frame
    ? slides.find((slide) => slide.frame.id === frame.id)
    : selected[0] && slideOf(slides, selected[0]);

  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const focusAfter = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (focusAfter.current === null) return;
    list.current
      ?.querySelectorAll<HTMLButtonElement>(".slide-thumb")
      [focusAfter.current]?.focus();
    focusAfter.current = null;
  });

  function patch(updates: Map<string, Record<string, any> | undefined>) {
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          updates.has(element.id)
            ? newElementWith(element, { customData: updates.get(element.id) })
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= slides.length) return;
    patch(
      new Map(
        move(slides, from, to).map((slide, order) => [
          slide.frame.id,
          withSlide(slide.frame.customData, { order }),
        ]),
      ),
    );
  }

  function setSettings(slide: Slide, settings: Partial<SlideSettings>) {
    patch(
      new Map([[slide.frame.id, withSlide(slide.frame.customData, settings)]]),
    );
  }

  function select(ids: string[]) {
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(
          ids.map((id) => [id, true as const]),
        ),
      },
    });
  }

  function show(slide: Slide) {
    select([slide.frame.id]);
    api.scrollToContent(slide.frame as ExcalidrawElement, {
      fitToViewport: true,
      viewportZoomFactor: 0.8,
      animate: true,
      duration: 300,
    });
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    if (drag) reorder(drag.from, drag.to > drag.from ? drag.to - 1 : drag.to);
    setDrag(null);
  }

  function createSlide(width: number, height: number) {
    const state = api.getAppState();
    const live = api.getSceneElements();
    const x = live.length ? Math.max(...live.map((element) => element.x + element.width)) + 160 :
      state.width / 2 / state.zoom.value - state.scrollX - width / 2;
    const y = current?.frame.y ?? (state.height / 2 / state.zoom.value - state.scrollY - height / 2);
    const [created] = convertToExcalidrawElements([{
      type: "frame", x, y, width, height, children: [], name: `Slide ${slides.length + 1}`,
      customData: { slide: { order: slides.length,
        aspectRatio: width / height } },
    }]);
    const frame = newElementWith(created, { x, y, width, height });
    const orders = new Map(slides.map((slide, order) => [slide.frame.id, order]));
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted().map((element) =>
      orders.has(element.id) ? newElementWith(element, { customData: withSlide(element.customData, { order: orders.get(element.id)! }) }) : element), frame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    api.setActiveTool({ type: "selection" });
    show(getSlides([frame])[0]);
  }

  const newSlide = <NewSlide onCreate={createSlide} onFreeform={() => api.setActiveTool({ type: "frame" })} />;

  if (!slides.length)
    return (
      <div className="slides-panel slides-empty">
        <Icon name="frame" size={32} />
        <p>Create your first slide</p>
        {newSlide}
        <button
          className="slides-button"
          onClick={() => api.setActiveTool({ type: "frame" })}
        >
          Frame tool <kbd>F</kbd>
        </button>
      </div>
    );

  return (
    <div className="slides-panel">
      {newSlide}
      <button className="slides-button primary" onClick={() => onPlay(null)}>
        <Icon name="play" size={16} />
        Present
      </button>
      <ol
        ref={list}
        className="slides-list"
        aria-label="Slides"
        onDragOver={(event) => {
          if (drag) event.preventDefault();
        }}
        onDrop={drop}
      >
        {slides.map((slide, index) => {
          const name =
            (slide.frame as ExcalidrawFrameLikeElement).name ||
            `Slide ${index + 1}`;
          const isCurrent = slide === current;
          return (
            <li
              key={slide.frame.id}
              draggable
              className={`slide-card ${isCurrent ? "current" : ""} ${slide.settings.hidden ? "skipped" : ""} ${drag?.from === index ? "dragging" : ""} ${drag?.to === index ? "drop-before" : ""} ${drag?.to === index + 1 && index === slides.length - 1 ? "drop-after" : ""}`}
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, slide.frame.id);
                event.dataTransfer.effectAllowed = "move";
                setDrag({ from: index, to: index });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const to =
                  event.clientY > box.top + box.height / 2 ? index + 1 : index;
                if (to !== drag.to) setDrag({ ...drag, to });
              }}
              onDragEnd={() => setDrag(null)}
            >
              <button
                className="slide-thumb"
                aria-current={isCurrent || undefined}
                aria-label={`${index + 1}. ${name}`}
                title={`${name} — double-click to present from here, ⌥↑ ⌥↓ to reorder`}
                onClick={() => show(slide)}
                onDoubleClick={() => onPlay(slide.frame.id)}
                onKeyDown={(event) => {
                  if (
                    !event.altKey ||
                    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  const to = index + (event.key === "ArrowUp" ? -1 : 1);
                  if (to < 0 || to >= slides.length) return;
                  focusAfter.current = to;
                  reorder(index, to);
                }}
              >
                <Thumbnail slide={slide} scene={scene} />
                <span className="slide-number">{index + 1}</span>
                {slide.settings.hidden && (
                  <span className="slide-badge" title="Skipped">
                    <Icon name="skip" size={14} />
                  </span>
                )}
              </button>
              <div className="slide-meta">
                <span className="label">{name}</span>
                {slide.steps.length > 0 && (
                  <span className="hint">
                    {slide.steps.length}{" "}
                    {slide.steps.length === 1 ? "build" : "builds"}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {current && (
        <Inspector
          key={current.frame.id}
          slide={current}
          index={slides.indexOf(current)}
          selected={selected}
          api={api}
          setSettings={(settings) => setSettings(current, settings)}
          patch={patch}
          select={select}
          onPlay={() => onPlay(current.frame.id)}
        />
      )}
    </div>
  );
}

function Inspector({
  slide,
  index,
  selected,
  setSettings,
  patch,
  select,
  onPlay,
  api,
}: {
  api: ExcalidrawImperativeAPI;
  slide: Slide<ExcalidrawElement>;
  index: number;
  selected: ExcalidrawElement[];
  setSettings: (settings: Partial<SlideSettings>) => void;
  patch: (updates: Map<string, Record<string, any> | undefined>) => void;
  select: (ids: string[]) => void;
  onPlay: () => void;
}) {
  const { settings } = slide;
  const speed = speeds.reduce((best, option) =>
    Math.abs(option.duration - settings.duration) <
    Math.abs(best.duration - settings.duration)
      ? option
      : best,
  );
  const members = new Set(slide.elements.map((element) => element.id));
  const others = selected.filter((element) => !isFrame(element));
  // Builds apply to whole elements: bound text follows its container.
  const targets = others.every((element) => members.has(element.id))
    ? others.filter(
        (element) => !("containerId" in element && element.containerId),
      )
    : [];
  const ranks = targets.map((element) => slide.ranks.get(element.id) ?? 0);
  const rank =
    ranks.length && ranks.every((value) => value === ranks[0])
      ? ranks[0]
      : null;
  const built = targets.filter((element) => readBuild(element));
  const effectsInUse = new Set(
    built.map((element) => readBuild(element)!.effect),
  );
  const effect = effectsInUse.size === 1 ? [...effectsInUse][0] : null;
  const owners = (step: number) =>
    slide.elements.filter((element) => readBuild(element)?.step === step);

  function setRank(value: string) {
    const step =
      value === "none"
        ? null
        : stepForRank(
            slide,
            value === "new" ? slide.steps.length + 1 : Number(value),
          );
    patch(
      new Map(
        targets.map((element) => [
          element.id,
          withBuild(
            element.customData,
            step === null
              ? null
              : {
                  step,
                  effect: readBuild(element)?.effect ?? effect ?? "fade",
                },
          ),
        ]),
      ),
    );
  }

  function setEffect(next: Effect) {
    patch(
      new Map(
        built.map((element) => [
          element.id,
          withBuild(element.customData, {
            ...readBuild(element)!,
            effect: next,
          }),
        ]),
      ),
    );
  }

  function swap(position: number, direction: -1 | 1) {
    const a = slide.steps[position],
      b = slide.steps[position + direction];
    patch(
      new Map(
        [...owners(a), ...owners(b)].map((element) => {
          const build = readBuild(element)!;
          return [
            element.id,
            withBuild(element.customData, {
              ...build,
              step: build.step === a ? b : a,
            }),
          ];
        }),
      ),
    );
  }

  return (
    <section
      className="slides-inspector"
      aria-label={`Slide ${index + 1} settings`}
    >
      <div className="inspector-row">
        <h3>Slide {index + 1}</h3>
        <button className="slides-button" onClick={onPlay}>
          <Icon name="play" size={14} />
          Present from here
        </button>
      </div>
      <FrameSize slide={slide} api={api} />
      <Field label="Transition">
        <Segmented
          value={settings.transition}
          options={transitions.map((value) => ({
            value,
            label: transitionLabels[value],
          }))}
          onChange={(transition) => setSettings({ transition })}
        />
      </Field>
      <Field label="Speed">
        <Segmented
          value={speed.duration}
          disabled={settings.transition === "cut"}
          options={speeds.map(({ label, duration }) => ({
            value: duration,
            label,
          }))}
          onChange={(duration) => setSettings({ duration })}
        />
      </Field>
      <label className="inspector-check">
        <input
          type="checkbox"
          checked={settings.hidden}
          onChange={(event) => setSettings({ hidden: event.target.checked })}
        />
        Skip when presenting
      </label>

      <h3>Builds</h3>
      {targets.length > 0 ? (
        <>
          <Field
            label={
              targets.length === 1
                ? "Selected element"
                : `${targets.length} selected elements`
            }
          >
            <select
              className="inspector-select"
              value={rank === null ? "" : rank === 0 ? "none" : String(rank)}
              onChange={(event) => setRank(event.target.value)}
            >
              {rank === null && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              <option value="none">Always visible</option>
              {slide.steps.map((_, position) => (
                <option key={position} value={String(position + 1)}>
                  Build {position + 1}
                </option>
              ))}
              <option value="new">New build {slide.steps.length + 1}</option>
            </select>
          </Field>
          {built.length > 0 && (
            <Field label="Effect">
              <Segmented
                value={effect}
                options={effects.map((value) => ({
                  value,
                  label: effectLabels[value],
                }))}
                onChange={setEffect}
              />
            </Field>
          )}
        </>
      ) : (
        <p className="hint">
          {others.length
            ? "Select elements inside this slide to build them in."
            : "Select elements on this slide to build them in one at a time."}
        </p>
      )}
      {slide.steps.length > 0 && (
        <ol className="build-list">
          {slide.steps.map((step, position) => {
            const count = owners(step).length;
            return (
              <li key={step}>
                <button
                  className="build-select"
                  onClick={() =>
                    select(owners(step).map((element) => element.id))
                  }
                >
                  <span className="build-rank">{position + 1}</span>
                  {count} {count === 1 ? "element" : "elements"}
                </button>
                <button
                  className="icon-button"
                  disabled={position === 0}
                  onClick={() => swap(position, -1)}
                  aria-label={`Move build ${position + 1} earlier`}
                  title="Earlier"
                >
                  <Icon name="up" size={14} />
                </button>
                <button
                  className="icon-button"
                  disabled={position === slide.steps.length - 1}
                  onClick={() => swap(position, 1)}
                  aria-label={`Move build ${position + 1} later`}
                  title="Later"
                >
                  <Icon name="down" size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-field">
      <span className="inspector-label">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Rendered thumbnails, by slide content and look. Old entries are dropped first.
const thumbnails = new Map<string, string>();

function Thumbnail({
  slide,
  scene,
}: {
  slide: Slide<ExcalidrawElement>;
  scene: Scene;
}) {
  const dark = scene.appState.theme === "dark";
  const background = scene.appState.viewBackgroundColor;
  const key = `${slide.version}|${dark}|${background}|${Object.keys(scene.files).length}`;
  const [url, setUrl] = useState(() => thumbnails.get(key) ?? null);
  const latest = useRef(scene);
  latest.current = scene;
  useEffect(() => {
    const cached = thumbnails.get(key);
    if (cached) return setUrl(cached);
    let cancelled = false;
    // Waits for edits to pause rather than rendering on every change.
    const timer = setTimeout(
      () => {
        const { elements, files } = latest.current;
        void exportToCanvas({
          elements: elements.filter(
            (element) => !element.isDeleted,
          ) as NonDeletedExcalidrawElement[],
          appState: {
            exportBackground: true,
            viewBackgroundColor: background,
            exportWithDarkMode: dark,
            frameRendering: {
              enabled: true,
              name: false,
              outline: false,
              clip: true,
            },
          },
          files,
          exportingFrame: slide.frame as ExcalidrawFrameLikeElement,
          exportPadding: 0,
          maxWidthOrHeight: 360,
        })
          .then((canvas: HTMLCanvasElement) => {
            if (cancelled) return;
            const data = canvas.toDataURL("image/png");
            thumbnails.set(key, data);
            if (thumbnails.size > 300)
              thumbnails.delete(thumbnails.keys().next().value!);
            setUrl(data);
          })
          .catch(() => {});
      },
      url ? 300 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);
  return url ? (
    <img src={url} alt="" draggable={false} />
  ) : (
    <span className="slide-placeholder" />
  );
}

const SIZE_KEY = "excali-slide-size";
function NewSlide({ onCreate, onFreeform }: {
  onCreate: (width: number, height: number) => void; onFreeform: () => void;
}) {
  const [size, setSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
      if (saved && validSize(saved.width, saved.height)) return saved as { width: number; height: number };
    } catch {}
    return { width: 1600, height: 900 };
  });
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState(() => slideSizes.find((option) => option.width === size.width && option.height === size.height)?.label ?? "custom");
  function create() {
    if (!validSize(size.width, size.height)) return;
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)); } catch {}
    onCreate(size.width, size.height);
    setOpen(false);
  }
  return <div className="new-slide">
    <div className="slide-create-row">
      <button className="slides-button" onClick={create} disabled={!validSize(size.width, size.height)}><Icon name="plus" size={14} />New slide</button>
      <button className="slides-button" aria-label="Slide size options" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="down" size={14} /></button>
    </div>
    {open && <div className="slide-size-options">
      <label className="inspector-field">Slide size
        <select className="inspector-select" value={preset} onChange={(event) => {
          setPreset(event.target.value);
          const option = slideSizes.find((option) => option.label === event.target.value);
          if (option) setSize({ width: option.width, height: option.height });
        }}>
          {slideSizes.map((option) => <option key={option.label}>{option.label}</option>)}
          <option value="custom">Custom</option>
        </select>
      </label>
      {preset === "custom" && <SizeInputs width={size.width} height={size.height} onChange={setSize} />}
      <button className="slides-button" onClick={create} disabled={!validSize(size.width, size.height)}>Create slide</button>
      <button className="slides-button" onClick={() => { onFreeform(); setOpen(false); }}>Freeform frame <kbd>F</kbd></button>
    </div>}
  </div>;
}

function validSize(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 && width <= 10000 && height <= 10000;
}
function SizeInputs({ width, height, onChange }: {
  width: number; height: number; onChange: (size: { width: number; height: number }) => void;
}) {
  return <div className="slide-dimensions">
    <label>Width<input type="number" aria-label="Slide width" min="1" max="10000" value={width || ""} onChange={(event) => onChange({ width: Number(event.target.value), height })} /></label>
    <label>Height<input type="number" aria-label="Slide height" min="1" max="10000" value={height || ""} onChange={(event) => onChange({ width, height: Number(event.target.value) })} /></label>
  </div>;
}
function FrameSize({ slide, api }: { slide: Slide<ExcalidrawElement>; api: ExcalidrawImperativeAPI }) {
  const { frame, settings } = slide;
  const [size, setSize] = useState({ width: frame.width, height: frame.height });
  useEffect(() => setSize({ width: frame.width, height: frame.height }), [frame.width, frame.height]);
  function resize(width: number, height: number) {
    if (!validSize(width, height)) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) => element.id === frame.id ?
        newElementWith(element, { width, height, customData: withSlide(element.customData, {
          aspectRatio: settings.aspectRatio ? width / height : null,
        }) }) : element),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  return <details className="frame-size">
    <summary>Slide size · {Math.round(frame.width)} × {Math.round(frame.height)}</summary>
    <label className="inspector-field">Aspect ratio
      <select className="inspector-select" aria-label="Slide aspect ratio" value={slideSizes.find((option) => Math.abs(frame.width / frame.height - option.width / option.height) < 0.001)?.label ?? "custom"} onChange={(event) => {
        const option = slideSizes.find((option) => option.label === event.target.value);
        if (option) resize(frame.width, frame.width * option.height / option.width);
      }}>
        {slideSizes.map((option) => <option key={option.label}>{option.label}</option>)}
        <option value="custom">Custom</option>
      </select>
    </label>
    <SizeInputs {...size} onChange={(next) => {
      if (settings.aspectRatio) {
        if (next.width !== size.width) next.height = next.width / settings.aspectRatio;
        else next.width = next.height * settings.aspectRatio;
      }
      setSize(next);
    }} />
    <button className="slides-button" disabled={!validSize(size.width, size.height)} onClick={() => resize(size.width, size.height)}>Apply size</button>
    <label className="inspector-check"><input type="checkbox" checked={!!settings.aspectRatio} onChange={(event) => {
      api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((element) => element.id === frame.id ? newElementWith(element, {
        customData: withSlide(element.customData, { aspectRatio: event.target.checked ? frame.width / frame.height : null }),
      }) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    }} />Lock aspect ratio</label>
    <p className="hint">Resizes the frame. Contents keep their size and position.</p>
  </details>;
}
