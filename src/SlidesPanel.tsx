import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Excalidraw,
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
  BUILD_DURATION,
  buildAppearance,
  fit,
  effects,
  buildTargets,
  buildOwners,
  buildLabel,
  reorderBuilds,
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
        if (!(event.metaKey || event.ctrlKey) || (key !== "z" && key !== "y"))
          return;
        if ((event.target as Element).closest("input, select, textarea"))
          return;
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
  `${hashElementsVersion(elements)}|${Object.keys(appState.selectedElementIds).join()}|${appState.viewBackgroundColor}|${appState.theme}|${Object.keys(files).length}|${appState.scrollX}:${appState.scrollY}:${appState.zoom.value}:${appState.width}:${appState.height}:${appState.offsetLeft}:${appState.offsetTop}`;

// The panel only mounts while open, so the scene is followed only then.
function Panel({
  api,
  onPlay,
}: {
  api: ExcalidrawImperativeAPI;
  onPlay: Play;
}) {
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
  const [activeSlide, setActiveSlide] = useState<string | null>(null);
  const inferred = frame
    ? slides.find((slide) => slide.frame.id === frame.id)
    : selected[0] && slideOf(slides, selected[0]);
  const current =
    inferred ?? slides.find((slide) => slide.frame.id === activeSlide);
  useEffect(() => {
    if (inferred) setActiveSlide(inferred.frame.id);
  }, [inferred?.frame.id]);

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
    setActiveSlide(slide.frame.id);
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
    const x = live.length
      ? Math.max(...live.map((element) => element.x + element.width)) + 160
      : state.width / 2 / state.zoom.value - state.scrollX - width / 2;
    const y =
      current?.frame.y ??
      state.height / 2 / state.zoom.value - state.scrollY - height / 2;
    const [created] = convertToExcalidrawElements([
      {
        type: "frame",
        x,
        y,
        width,
        height,
        children: [],
        name: `Slide ${slides.length + 1}`,
        customData: {
          slide: { order: slides.length, aspectRatio: width / height },
        },
      },
    ]);
    const frame = newElementWith(created, { x, y, width, height });
    const orders = new Map(
      slides.map((slide, order) => [slide.frame.id, order]),
    );
    api.updateScene({
      elements: [
        ...api.getSceneElementsIncludingDeleted().map((element) =>
          orders.has(element.id)
            ? newElementWith(element, {
                customData: withSlide(element.customData, {
                  order: orders.get(element.id)!,
                }),
              })
            : element,
        ),
        frame,
      ],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.setActiveTool({ type: "selection" });
    show(getSlides([frame])[0]);
  }

  const newSlide = (
    <NewSlide
      onCreate={createSlide}
      onFreeform={() => api.setActiveTool({ type: "frame" })}
    />
  );

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
          scene={scene}
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
  scene,
}: {
  scene: Scene;
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
  const [preview, setPreview] = useState(false);
  const [badges, setBadges] = useState(true);
  const speed = speeds.reduce((best, option) =>
    Math.abs(option.duration - settings.duration) <
    Math.abs(best.duration - settings.duration)
      ? option
      : best,
  );
  const others = selected.filter((element) => !isFrame(element));
  const targets = buildTargets(slide, selected);
  const [buildDrag, setBuildDrag] = useState<number | null>(null);
  const [dropBuild, setDropBuild] = useState<number | null>(null);
  const buildList = useRef<HTMLOListElement>(null);
  const buildFocus = useRef<number | null>(null);
  useEffect(() => {
    if (buildFocus.current === null) return;
    buildList.current
      ?.querySelectorAll<HTMLButtonElement>(".build-select")
      [buildFocus.current]?.focus();
    buildFocus.current = null;
  });
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
  const owners = (step: number) => buildOwners(slide, step);

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

  function reorderBuild(from: number, to: number) {
    if (from === to || to < 0 || to >= slide.steps.length) return;
    patch(reorderBuilds(slide, from, to));
  }

  function revealSeparately() {
    const first = (slide.steps.at(-1) ?? 0) + 1;
    patch(
      new Map(
        targets.map((element, index) => [
          element.id,
          withBuild(element.customData, {
            step: first + index,
            effect: readBuild(element)?.effect ?? "fade",
          }),
        ]),
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

      <div className="inspector-row">
        <h3>Animations</h3>
        <button
          className="slides-button"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Stop preview" : "Preview"}
        </button>
      </div>
      {preview && <SlidePreview slide={slide} scene={scene} />}
      <label className="inspector-check">
        <input
          type="checkbox"
          checked={badges}
          onChange={(event) => setBadges(event.target.checked)}
        />
        Show build numbers on canvas
      </label>
      {badges && (
        <BuildBadges slide={slide} state={scene.appState} select={select} />
      )}
      {targets.length > 0 ? (
        <>
          <div className="build-actions">
            <button className="slides-button" onClick={() => setRank("new")}>
              Reveal together
            </button>
            <button
              className="slides-button"
              disabled={targets.length < 2}
              onClick={revealSeparately}
            >
              Reveal separately
            </button>
          </div>
          <Field
            label={
              targets.length === 1
                ? "Selected element"
                : `${targets.length} selected elements`
            }
          >
            <select
              className="inspector-select"
              aria-label="Selected objects build"
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
        <ol
          className="build-list"
          aria-label="Animation builds"
          ref={buildList}
        >
          {slide.steps.map((step, position) => {
            const objects = owners(step);
            const labels = objects.filter(
              (element) => !("containerId" in element && element.containerId),
            );
            const name = (labels.length ? labels : objects)
              .map((element) => buildLabel(slide, element))
              .join(", ");
            const selectedBuild = targets.some(
              (element) => slide.ranks.get(element.id) === position + 1,
            );
            const rowEffects = new Set(
              objects.map((element) => readBuild(element)!.effect),
            );
            return (
              <li
                key={step}
                className={`${selectedBuild ? "selected" : ""} ${dropBuild === position ? "build-drop" : ""}`}
                onDragOver={(event) => {
                  if (buildDrag !== null) {
                    event.preventDefault();
                    setDropBuild(position);
                  }
                }}
                onDrop={(event) => {
                  if (buildDrag === null) return;
                  event.preventDefault();
                  reorderBuild(buildDrag, position);
                  setBuildDrag(null);
                  setDropBuild(null);
                }}
              >
                <div className="build-row">
                  <button
                    className="build-select"
                    draggable
                    aria-pressed={selectedBuild}
                    title={`${name} — drag or use ⌥↑ / ⌥↓ to reorder`}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-excali-build",
                        String(position),
                      );
                      event.dataTransfer.effectAllowed = "move";
                      setBuildDrag(position);
                    }}
                    onDragEnd={() => {
                      setBuildDrag(null);
                      setDropBuild(null);
                    }}
                    onKeyDown={(event) => {
                      if (
                        !event.altKey ||
                        !["ArrowUp", "ArrowDown"].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      const to = position + (event.key === "ArrowUp" ? -1 : 1);
                      if (to < 0 || to >= slide.steps.length) return;
                      buildFocus.current = to;
                      reorderBuild(position, to);
                    }}
                    onClick={() => select(objects.map((element) => element.id))}
                  >
                    <span className="build-rank">{position + 1}</span>
                    <span className="build-name">{name}</span>
                  </button>
                  <button
                    className="icon-button"
                    disabled={position === 0}
                    onClick={() => reorderBuild(position, position - 1)}
                    aria-label={`Move build ${position + 1} earlier`}
                    title="Earlier"
                  >
                    <Icon name="up" size={14} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={position === slide.steps.length - 1}
                    onClick={() => reorderBuild(position, position + 1)}
                    aria-label={`Move build ${position + 1} later`}
                    title="Later"
                  >
                    <Icon name="down" size={14} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove build ${position + 1}`}
                    title="Remove animation"
                    onClick={() =>
                      patch(
                        new Map(
                          objects.map((element) => [
                            element.id,
                            withBuild(element.customData, null),
                          ]),
                        ),
                      )
                    }
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <label className="build-effect">
                  Effect
                  <select
                    className="inspector-select"
                    aria-label={`Build ${position + 1} effect`}
                    value={rowEffects.size === 1 ? [...rowEffects][0] : ""}
                    onChange={(event) =>
                      patch(
                        new Map(
                          objects.map((element) => [
                            element.id,
                            withBuild(element.customData, {
                              step,
                              effect: event.target.value as Effect,
                            }),
                          ]),
                        ),
                      )
                    }
                  >
                    {rowEffects.size > 1 && (
                      <option value="" disabled>
                        Mixed
                      </option>
                    )}
                    {effects.map((effect) => (
                      <option key={effect} value={effect}>
                        {effectLabels[effect]}
                      </option>
                    ))}
                  </select>
                </label>
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
function NewSlide({
  onCreate,
  onFreeform,
}: {
  onCreate: (width: number, height: number) => void;
  onFreeform: () => void;
}) {
  const [size, setSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
      if (saved && validSize(saved.width, saved.height))
        return saved as { width: number; height: number };
    } catch {}
    return { width: 1600, height: 900 };
  });
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState(
    () =>
      slideSizes.find(
        (option) =>
          option.width === size.width && option.height === size.height,
      )?.label ?? "custom",
  );
  function create() {
    if (!validSize(size.width, size.height)) return;
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    } catch {}
    onCreate(size.width, size.height);
    setOpen(false);
  }
  return (
    <div className="new-slide">
      <div className="slide-create-row">
        <button
          className="slides-button"
          onClick={create}
          disabled={!validSize(size.width, size.height)}
        >
          <Icon name="plus" size={14} />
          New slide
        </button>
        <button
          className="slides-button"
          aria-label="Slide size options"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="down" size={14} />
        </button>
      </div>
      {open && (
        <div className="slide-size-options">
          <label className="inspector-field">
            Slide size
            <select
              className="inspector-select"
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                const option = slideSizes.find(
                  (option) => option.label === event.target.value,
                );
                if (option)
                  setSize({ width: option.width, height: option.height });
              }}
            >
              {slideSizes.map((option) => (
                <option key={option.label}>{option.label}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          {preset === "custom" && (
            <SizeInputs
              width={size.width}
              height={size.height}
              onChange={setSize}
            />
          )}
          <button
            className="slides-button"
            onClick={create}
            disabled={!validSize(size.width, size.height)}
          >
            Create slide
          </button>
          <button
            className="slides-button"
            onClick={() => {
              onFreeform();
              setOpen(false);
            }}
          >
            Freeform frame <kbd>F</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

function validSize(width: number, height: number) {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= 10000 &&
    height <= 10000
  );
}
function SizeInputs({
  width,
  height,
  onChange,
}: {
  width: number;
  height: number;
  onChange: (size: { width: number; height: number }) => void;
}) {
  return (
    <div className="slide-dimensions">
      <label>
        Width
        <input
          type="number"
          aria-label="Slide width"
          min="1"
          max="10000"
          value={width || ""}
          onChange={(event) =>
            onChange({ width: Number(event.target.value), height })
          }
        />
      </label>
      <label>
        Height
        <input
          type="number"
          aria-label="Slide height"
          min="1"
          max="10000"
          value={height || ""}
          onChange={(event) =>
            onChange({ width, height: Number(event.target.value) })
          }
        />
      </label>
    </div>
  );
}
function FrameSize({
  slide,
  api,
}: {
  slide: Slide<ExcalidrawElement>;
  api: ExcalidrawImperativeAPI;
}) {
  const { frame, settings } = slide;
  const [size, setSize] = useState({
    width: frame.width,
    height: frame.height,
  });
  useEffect(
    () => setSize({ width: frame.width, height: frame.height }),
    [frame.width, frame.height],
  );
  function resize(width: number, height: number) {
    if (!validSize(width, height)) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frame.id
          ? newElementWith(element, {
              width,
              height,
              customData: withSlide(element.customData, {
                aspectRatio: settings.aspectRatio ? width / height : null,
              }),
            })
          : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  return (
    <details className="frame-size">
      <summary>
        Slide size · {Math.round(frame.width)} × {Math.round(frame.height)}
      </summary>
      <label className="inspector-field">
        Aspect ratio
        <select
          className="inspector-select"
          aria-label="Slide aspect ratio"
          value={
            slideSizes.find(
              (option) =>
                Math.abs(
                  frame.width / frame.height - option.width / option.height,
                ) < 0.001,
            )?.label ?? "custom"
          }
          onChange={(event) => {
            const option = slideSizes.find(
              (option) => option.label === event.target.value,
            );
            if (option)
              resize(frame.width, (frame.width * option.height) / option.width);
          }}
        >
          {slideSizes.map((option) => (
            <option key={option.label}>{option.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      <SizeInputs
        {...size}
        onChange={(next) => {
          if (settings.aspectRatio) {
            if (next.width !== size.width)
              next.height = next.width / settings.aspectRatio;
            else next.width = next.height * settings.aspectRatio;
          }
          setSize(next);
        }}
      />
      <button
        className="slides-button"
        disabled={!validSize(size.width, size.height)}
        onClick={() => resize(size.width, size.height)}
      >
        Apply size
      </button>
      <label className="inspector-check">
        <input
          type="checkbox"
          checked={!!settings.aspectRatio}
          onChange={(event) => {
            api.updateScene({
              elements: api.getSceneElementsIncludingDeleted().map((element) =>
                element.id === frame.id
                  ? newElementWith(element, {
                      customData: withSlide(element.customData, {
                        aspectRatio: event.target.checked
                          ? frame.width / frame.height
                          : null,
                      }),
                    })
                  : element,
              ),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
          }}
        />
        Lock aspect ratio
      </label>
      <p className="hint">
        Resizes the frame. Contents keep their size and position.
      </p>
    </details>
  );
}

function BuildBadges({
  slide,
  state,
  select,
}: {
  slide: Slide<ExcalidrawElement>;
  state: AppState;
  select: (ids: string[]) => void;
}) {
  return createPortal(
    <div
      className="build-badges"
      style={{
        left: state.offsetLeft,
        top: state.offsetTop,
        width: state.width,
        height: state.height,
      }}
    >
      {slide.elements
        .filter(
          (element) =>
            slide.ranks.has(element.id) &&
            !("containerId" in element && element.containerId),
        )
        .map((element) => {
          const rank = slide.ranks.get(element.id)!;
          return (
            <button
              key={element.id}
              className="canvas-build-badge"
              style={{
                left: (element.x + state.scrollX) * state.zoom.value,
                top: (element.y + state.scrollY) * state.zoom.value,
              }}
              aria-label={`Build ${rank}: ${buildLabel(slide, element)}`}
              title={`Build ${rank}: ${buildLabel(slide, element)}`}
              onClick={() => select([element.id])}
            >
              {rank}
            </button>
          );
        })}
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

const previewFrameRendering = {
  enabled: true,
  clip: true,
  name: false,
  outline: false,
};
function SlidePreview({
  slide,
  scene,
}: {
  slide: Slide<ExcalidrawElement>;
  scene: Scene;
}) {
  const [step, setStep] = useState(0);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(0);
  const level = Math.min(step, slide.steps.length);
  useEffect(
    () => setStep((value) => Math.min(value, slide.steps.length)),
    [slide.steps.length],
  );
  const onApi = useCallback(
    (value: ExcalidrawImperativeAPI) => setApi(value),
    [],
  );
  const base = useMemo(
    () => structuredClone([slide.frame, ...slide.elements]),
    [slide.version],
  );
  const initial = useMemo(
    () => ({
      elements: base.map((element) =>
        slide.ranks.has(element.id)
          ? newElementWith(element, { opacity: 0 })
          : element,
      ),
      files: scene.files,
      appState: {
        viewBackgroundColor: scene.appState.viewBackgroundColor,
        frameRendering: previewFrameRendering,
      },
    }),
    [],
  );

  useEffect(() => {
    if (!api || !root.current) return;
    const center = () => {
      const { width, height } = root.current!.getBoundingClientRect();
      const camera = fit(slide.frame, { width, height });
      api.updateScene({
        appState: {
          scrollX: camera.scrollX,
          scrollY: camera.scrollY,
          zoom: { value: camera.zoom } as AppState["zoom"],
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.updateFrameRendering(previewFrameRendering);
    };
    root.current.setAttribute("inert", "");
    const observer = new ResizeObserver(center);
    observer.observe(root.current);
    center();
    return () => observer.disconnect();
  }, [
    api,
    slide.frame.x,
    slide.frame.y,
    slide.frame.width,
    slide.frame.height,
  ]);

  useEffect(() => {
    if (!api) return;
    api.addFiles(Object.values(scene.files));
    const animate =
      level === previous.current + 1 &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    previous.current = level;
    const begin = performance.now();
    let raf = 0;
    const paint = (now: number) => {
      const progress = animate
        ? Math.min((now - begin) / BUILD_DURATION, 1)
        : 1;
      api.updateScene({
        elements: base.map((element) => {
          const appearance = buildAppearance(
            slide,
            element,
            level,
            progress,
            28 / api.getAppState().zoom.value,
          );
          return appearance.opacity === element.opacity &&
            appearance.y === element.y
            ? element
            : newElementWith(element, appearance);
        }),
        appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (progress < 1) raf = requestAnimationFrame(paint);
    };
    paint(begin);
    return () => cancelAnimationFrame(raf);
  }, [api, base, level, scene.files, scene.appState.viewBackgroundColor]);

  return (
    <div
      className="slide-preview"
      role="group"
      aria-label="Build preview"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        setStep(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? slide.steps.length
              : Math.max(
                  0,
                  Math.min(
                    slide.steps.length,
                    level + (event.key === "ArrowRight" ? 1 : -1),
                  ),
                ),
        );
      }}
    >
      <div
        ref={root}
        className="slide-preview-stage"
        style={{ aspectRatio: slide.frame.width / slide.frame.height }}
        aria-hidden="true"
      >
        <Excalidraw
          initialData={initial}
          excalidrawAPI={onApi}
          viewModeEnabled
          zenModeEnabled
          theme={scene.appState.theme}
        />
      </div>
      <div className="preview-controls">
        <button
          className="icon-button"
          disabled={level === 0}
          aria-label="Previous build preview"
          onClick={() => setStep(level - 1)}
        >
          <Icon name="previous" size={14} />
        </button>
        <span role="status" aria-live="polite">
          Step {level} of {slide.steps.length}
        </span>
        <button
          className="icon-button"
          disabled={level === slide.steps.length}
          aria-label="Next build preview"
          onClick={() => setStep(level + 1)}
        >
          <Icon name="next" size={14} />
        </button>
        <button
          className="slides-button"
          aria-label="Restart build preview"
          onClick={() => setStep(0)}
        >
          Restart
        </button>
      </div>
      <p className="hint">
        {level === 0
          ? "Before the first click"
          : `Revealed through build ${level}`}
      </p>
    </div>
  );
}
