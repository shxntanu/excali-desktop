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
  getCommonBounds,
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
  duplicateSlideElements,
  layoutElements,
  safeArea,
  slideLayouts,
  type SlideLayout,
} from "./slide-authoring";
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
  readDeck,
  readSlide,
  withDeck,
  type DeckDefaults,
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
const DEFAULT_SIZE = { width: 1600, height: 900 };

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
      {api ? (
        <Panel api={api} onPlay={onPlay} onClose={onClose} />
      ) : (
        <PanelHeader onClose={onClose} />
      )}
    </aside>
  );
}

function PanelHeader({
  onClose,
  children,
}: {
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="slides-header">
      <h2>Slides</h2>
      {children}
      <button
        className="icon-button"
        onClick={onClose}
        aria-label="Hide slides"
        title="Hide slides"
      >
        <Icon name="close" />
      </button>
    </header>
  );
}

// Styled with Excalidraw's own trigger classes so it matches the library button beside it.
export function SlidesTrigger({
  onOpen,
  onPlay,
}: {
  onOpen: () => void;
  onPlay: () => void;
}) {
  return (
    <div className="slides-triggers">
      <button
        className="sidebar-trigger default-sidebar-trigger"
        onClick={onOpen}
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
  onClose,
}: {
  api: ExcalidrawImperativeAPI;
  onPlay: Play;
  onClose: () => void;
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
  const [pendingDeck, setPendingDeck] = useState(() => readDeck([]));
  const deck = slides.length ? readDeck(scene.elements) : pendingDeck;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
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

  function sizeFor(slide: Slide | undefined) {
    return (
      deck.size ??
      (slide
        ? { width: slide.frame.width, height: slide.frame.height }
        : DEFAULT_SIZE)
    );
  }

  function createSlide(
    after: Slide<ExcalidrawElement> | undefined,
    layout: SlideLayout = "blank",
  ) {
    const { width, height } = sizeFor(after ?? slides.at(-1));
    const state = api.getAppState();
    const live = api.getSceneElements();
    const x = live.length
      ? Math.max(...live.map((element) => element.x + element.width)) + 160
      : state.width / 2 / state.zoom.value - state.scrollX - width / 2;
    const y =
      after?.frame.y ??
      state.height / 2 / state.zoom.value - state.scrollY - height / 2;
    const content = convertToExcalidrawElements(
      layoutElements(layout, { x, y, width, height }),
      { regenerateIds: false },
    );
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
          deck,
          slide: {
            order: slides.length,
            aspectRatio: width / height,
            transition: deck.transition,
            duration: deck.duration,
          },
        },
      },
    ]);
    const frame = newElementWith(created, { x, y, width, height });
    const order = after ? slides.indexOf(after) + 1 : slides.length;
    const orders = new Map(
      slides.map((slide, index) => [
        slide.frame.id,
        index < order ? index : index + 1,
      ]),
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
        ...content.map((element) =>
          newElementWith(element, { frameId: frame.id }),
        ),
        newElementWith(frame, {
          customData: withSlide(frame.customData, { order }),
        }),
      ],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.setActiveTool({ type: "selection" });
    show(getSlides([frame])[0]);
  }

  function duplicate(slide: Slide<ExcalidrawElement>) {
    const right = Math.max(
      ...api.getSceneElements().map((element) => element.x + element.width),
    );
    const copies = duplicateSlideElements(
      slide,
      right + 160 - slide.frame.x,
      0,
    );
    const frame = copies[0] as ExcalidrawFrameLikeElement;
    const order = slides.indexOf(slide) + 1;
    const orders = new Map(
      slides.map((item, index) => [
        item.frame.id,
        index < order ? index : index + 1,
      ]),
    );
    copies[0] = newElementWith(frame, {
      name: `${frame.name || `Slide ${order}`} copy`,
      customData: withSlide(frame.customData, { order }),
    });
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
        ...copies,
      ],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    show(getSlides(copies)[0]);
  }

  function rename(slide: Slide<ExcalidrawElement>, name: string) {
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          element.id === slide.frame.id &&
          (element.type === "frame" || element.type === "magicframe")
            ? newElementWith(element, { name })
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function removeSlide(slide: Slide<ExcalidrawElement>) {
    setPendingDeck(deck);
    const removed = new Set([
      slide.frame.id,
      ...slide.elements.map((element) => element.id),
    ]);
    const remaining = slides.filter((item) => item !== slide);
    const orders = new Map(
      remaining.map((item, order) => [item.frame.id, order]),
    );
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) => {
        if (removed.has(element.id))
          return newElementWith(element, { isDeleted: true });
        let next = element;
        if (orders.has(element.id))
          next = newElementWith(next, {
            customData: withSlide(next.customData, {
              order: orders.get(element.id)!,
            }),
          });
        if (element.boundElements?.some((bound) => removed.has(bound.id)))
          next = newElementWith(next, {
            boundElements: element.boundElements.filter(
              (bound) => !removed.has(bound.id),
            ),
          });
        if ("startBinding" in next)
          next = newElementWith(next, {
            startBinding:
              next.startBinding && removed.has(next.startBinding.elementId)
                ? null
                : next.startBinding,
            endBinding:
              next.endBinding && removed.has(next.endBinding.elementId)
                ? null
                : next.endBinding,
          });
        return next;
      }),
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    const next =
      remaining[Math.min(slides.indexOf(slide), remaining.length - 1)];
    if (next) show(next);
    else setActiveSlide(null);
  }

  function setDeck(patchDefaults: Partial<DeckDefaults>) {
    const next = { ...deck, ...patchDefaults };
    setPendingDeck(next);
    patch(
      new Map(
        slides.map((slide) => [
          slide.frame.id,
          withDeck(slide.frame.customData, next),
        ]),
      ),
    );
  }

  function applyDeck(kind: "size" | "transition" | "effect") {
    const frames = new Set(slides.map((slide) => slide.frame.id));
    const members = new Set(
      slides.flatMap((slide) => slide.elements.map((element) => element.id)),
    );
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) => {
        if (element.isDeleted) return element;
        if (kind === "size" && frames.has(element.id) && deck.size)
          return newElementWith(element, {
            width: deck.size.width,
            height: deck.size.height,
            customData: withSlide(element.customData, {
              aspectRatio: readSlide(element).aspectRatio
                ? deck.size.width / deck.size.height
                : null,
            }),
          });
        if (kind === "transition" && frames.has(element.id))
          return newElementWith(element, {
            customData: withSlide(element.customData, {
              transition: deck.transition,
              duration: deck.duration,
            }),
          });
        const build =
          kind === "effect" && members.has(element.id) && readBuild(element);
        if (build)
          return newElementWith(element, {
            customData: withBuild(element.customData, {
              ...build,
              effect: deck.effect,
            }),
          });
        return element;
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  const header = (
    <PanelHeader onClose={onClose}>
      <button
        className="icon-button"
        aria-pressed={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
        aria-label="Deck settings"
        title="Deck settings"
      >
        <Icon name="settings" />
      </button>
      <button
        className="icon-button accent"
        disabled={!slides.length}
        onClick={() => onPlay(null)}
        aria-label="Present"
        title="Present (⇧⌘P)"
      >
        <Icon name="play" size={16} />
      </button>
    </PanelHeader>
  );

  const top = (
    <>
      {settingsOpen && (
        <DeckSettings
          deck={deck}
          onChange={setDeck}
          onApply={applyDeck}
          hasSlides={slides.length > 0}
        />
      )}
      <NewSlide
        onCreate={(layout) => createSlide(current, layout)}
        onFreeform={() => api.setActiveTool({ type: "frame" })}
      />
    </>
  );

  if (!slides.length)
    return (
      <>
        {header}
        <div className="slides-panel">
          {top}
          <div className="slides-empty">
            <Icon name="frame" size={28} />
            <p>No slides yet</p>
            <p className="hint">
              Add a slide above, or draw a frame on the canvas with{" "}
              <kbd>F</kbd>.
            </p>
          </div>
        </div>
      </>
    );

  return (
    <>
      {header}
      <div className="slides-panel">
        {top}
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
                draggable={renaming !== slide.frame.id}
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
                    event.clientY > box.top + box.height / 2
                      ? index + 1
                      : index;
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
                  {renaming === slide.frame.id ? (
                    <NameField
                      name={name}
                      onDone={(value) => {
                        setRenaming(null);
                        if (value && value !== name) rename(slide, value);
                      }}
                    />
                  ) : (
                    <span
                      className="label"
                      onDoubleClick={() => setRenaming(slide.frame.id)}
                    >
                      {name}
                    </span>
                  )}
                  {slide.steps.length > 0 && (
                    <span
                      className="hint"
                      title={`${slide.steps.length} reveal ${slide.steps.length === 1 ? "step" : "steps"}`}
                    >
                      {slide.steps.length}{" "}
                      {slide.steps.length === 1 ? "step" : "steps"}
                    </span>
                  )}
                  <Dropdown
                    label={`Actions for ${name}`}
                    className="icon-button slide-more"
                    trigger={<Icon name="more" size={16} />}
                    items={[
                      {
                        label: "New slide after",
                        onSelect: () => createSlide(slide),
                      },
                      {
                        label: "Duplicate",
                        onSelect: () => duplicate(slide),
                      },
                      {
                        label: "Rename",
                        onSelect: () => setRenaming(slide.frame.id),
                      },
                      null,
                      {
                        label: "Delete",
                        danger: true,
                        onSelect: () => removeSlide(slide),
                      },
                    ]}
                  />
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
            defaultEffect={deck.effect}
            setSettings={(settings) => setSettings(current, settings)}
            patch={patch}
            select={select}
            onPlay={() => onPlay(current.frame.id)}
          />
        )}
      </div>
    </>
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
  defaultEffect,
}: {
  defaultEffect: Effect;
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
  const steps = slide.steps.length;

  function setRank(value: string) {
    if (value === "each") return revealSeparately();
    const step =
      value === "none"
        ? null
        : stepForRank(slide, value === "new" ? steps + 1 : Number(value));
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
                  effect: readBuild(element)?.effect ?? effect ?? defaultEffect,
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
    if (from === to || to < 0 || to >= steps) return;
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
            effect: readBuild(element)?.effect ?? defaultEffect,
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
      <div className="inspector-heading">
        <h3>Slide {index + 1}</h3>
        <button
          className="icon-button"
          onClick={onPlay}
          aria-label="Present from this slide"
          title="Present from this slide"
        >
          <Icon name="play" size={14} />
        </button>
      </div>
      <Field label="Transition">
        <Segmented
          value={settings.transition}
          options={transitions.map((value) => ({
            value,
            label: transitionLabels[value],
          }))}
          onChange={(transition) => setSettings({ transition })}
        />
        {settings.transition !== "cut" && (
          <Segmented
            label="Transition speed"
            value={speed.duration}
            options={speeds.map(({ label, duration }) => ({
              value: duration,
              label,
            }))}
            onChange={(duration) => setSettings({ duration })}
          />
        )}
      </Field>
      <label className="inspector-check">
        <input
          type="checkbox"
          checked={settings.hidden}
          onChange={(event) => setSettings({ hidden: event.target.checked })}
        />
        Skip when presenting
      </label>
      <SlideLayoutTools
        slide={slide}
        selected={selected}
        api={api}
        state={scene.appState}
      />

      <div className="inspector-heading">
        <h3>Reveal steps</h3>
        <div className="heading-actions">
          <button
            className="chip"
            aria-pressed={badges}
            onClick={() => setBadges(!badges)}
            title="Show step numbers on the canvas"
          >
            Numbers
          </button>
          <button
            className="chip"
            aria-pressed={preview && steps > 0}
            disabled={!steps}
            onClick={() => setPreview(!preview)}
            title="Preview the reveal steps"
          >
            Preview
          </button>
        </div>
      </div>
      {preview && steps > 0 && <SlidePreview slide={slide} scene={scene} />}
      {badges && (
        <BuildBadges slide={slide} state={scene.appState} select={select} />
      )}
      {targets.length > 0 ? (
        <div className="build-editor">
          <Field
            label={
              targets.length === 1
                ? buildLabel(slide, targets[0])
                : `${targets.length} objects`
            }
          >
            <select
              className="inspector-select"
              aria-label="When the selection appears"
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
                  Step {position + 1}
                </option>
              ))}
              <option value="new">New step</option>
              {targets.length > 1 && (
                <option value="each">New step for each</option>
              )}
            </select>
          </Field>
          {built.length > 0 && (
            <Segmented
              label="Reveal effect"
              value={effect}
              options={effects.map((value) => ({
                value,
                label: effectLabels[value],
              }))}
              onChange={setEffect}
            />
          )}
        </div>
      ) : others.length ? (
        <p className="hint">Select objects inside this slide to reveal them.</p>
      ) : (
        !steps && (
          <p className="hint">
            Select objects on this slide to reveal them one step at a time.
          </p>
        )
      )}
      {steps > 0 && (
        <ol className="build-list" aria-label="Reveal steps" ref={buildList}>
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
                <button
                  className="build-select"
                  draggable
                  aria-pressed={selectedBuild}
                  title={`${name} — drag or use ⌥↑ ⌥↓ to reorder`}
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
                    if (to < 0 || to >= steps) return;
                    buildFocus.current = to;
                    reorderBuild(position, to);
                  }}
                  onClick={() => select(objects.map((element) => element.id))}
                >
                  <span className="build-rank">{position + 1}</span>
                  <span className="build-name">{name}</span>
                  <span className="build-effect">
                    {rowEffects.size === 1
                      ? effectLabels[[...rowEffects][0]]
                      : "Mixed"}
                  </span>
                </button>
                <button
                  className="icon-button build-remove"
                  aria-label={`Remove reveal step ${position + 1}`}
                  title="Always show these objects"
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
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="inspector-field">
      <div className="inspector-label">
        <span>{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label?: string;
  value: T | null;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
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

type MenuItem = { label: ReactNode; onSelect: () => void; danger?: boolean };

// A null item draws a separator.
function Dropdown({
  label,
  className,
  trigger,
  items,
}: {
  label: string;
  className: string;
  trigger: ReactNode;
  items: (MenuItem | null)[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      className="dropdown"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        } else if (event.key === "Tab") {
          setOpen(false);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const entries = [
            ...root.current!.querySelectorAll<HTMLElement>("[role=menuitem]"),
          ];
          const at = entries.indexOf(document.activeElement as HTMLElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          entries[(at + step + entries.length) % entries.length]?.focus();
        }
      }}
    >
      <button
        ref={button}
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div className="dropdown-menu" role="menu" aria-label={label}>
          {items.map((item, index) =>
            item ? (
              <button
                key={index}
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ) : (
              <hr key={index} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NameField({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null) => void;
}) {
  const finished = useRef(false);
  const finish = (value: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value?.trim() || null);
  };
  return (
    <input
      className="slide-name-field"
      aria-label="Slide name"
      defaultValue={name}
      maxLength={200}
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(null);
        }
      }}
    />
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

function NewSlide({
  onCreate,
  onFreeform,
}: {
  onCreate: (layout: SlideLayout) => void;
  onFreeform: () => void;
}) {
  return (
    <div className="new-slide">
      <button className="slides-button" onClick={() => onCreate("blank")}>
        <Icon name="plus" size={14} />
        New slide
      </button>
      <Dropdown
        label="New slide from a layout"
        className="slides-button"
        trigger={<Icon name="down" size={14} />}
        items={[
          ...slideLayouts.map((option) => ({
            label: option.label,
            onSelect: () => onCreate(option.value),
          })),
          null,
          {
            label: (
              <>
                Draw a frame <kbd>F</kbd>
              </>
            ),
            onSelect: onFreeform,
          },
        ]}
      />
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

const presetOf = (size: { width: number; height: number }) =>
  slideSizes.find(
    (option) =>
      Math.abs(size.width / size.height - option.width / option.height) <
      0.001,
  )?.label ?? "custom";

function SizeInputs({
  width,
  height,
  onChange,
  children,
}: {
  width: number;
  height: number;
  onChange: (size: { width: number; height: number }) => void;
  children?: ReactNode;
}) {
  return (
    <div className="slide-dimensions">
      <label title="Width">
        <span>W</span>
        <input
          type="number"
          aria-label="Width"
          min="1"
          max="10000"
          value={width ? Math.round(width) : ""}
          onChange={(event) =>
            onChange({ width: Number(event.target.value), height })
          }
        />
      </label>
      <label title="Height">
        <span>H</span>
        <input
          type="number"
          aria-label="Height"
          min="1"
          max="10000"
          value={height ? Math.round(height) : ""}
          onChange={(event) =>
            onChange({ width, height: Number(event.target.value) })
          }
        />
      </label>
      {children}
    </div>
  );
}

function SlideLayoutTools({
  slide,
  selected,
  api,
  state,
}: {
  slide: Slide<ExcalidrawElement>;
  selected: ExcalidrawElement[];
  api: ExcalidrawImperativeAPI;
  state: AppState;
}) {
  const [open, setOpen] = useState(false);
  const [guides, setGuides] = useState(false);
  return (
    <details
      className="inspector-group"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Size and alignment
        <span className="hint">
          {Math.round(slide.frame.width)} × {Math.round(slide.frame.height)}
        </span>
      </summary>
      <FrameSize slide={slide} api={api} />
      <SlideAlignment slide={slide} selected={selected} api={api} />
      <label className="inspector-check">
        <input
          type="checkbox"
          checked={guides}
          onChange={(event) => setGuides(event.target.checked)}
        />
        Show safe area and center guides
      </label>
      {open && guides && <SlideGuides slide={slide} state={state} />}
    </details>
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
  function update(
    width: number,
    height: number,
    aspectRatio: number | null = settings.aspectRatio ? width / height : null,
  ) {
    if (!validSize(width, height)) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frame.id
          ? newElementWith(element, {
              width,
              height,
              customData: withSlide(element.customData, { aspectRatio }),
            })
          : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  const changed =
    Math.round(size.width) !== Math.round(frame.width) ||
    Math.round(size.height) !== Math.round(frame.height);
  return (
    <Field
      label="Size"
      action={
        <label className="inspector-check small">
          <input
            type="checkbox"
            checked={!!settings.aspectRatio}
            onChange={(event) =>
              update(
                frame.width,
                frame.height,
                event.target.checked ? frame.width / frame.height : null,
              )
            }
          />
          Lock ratio
        </label>
      }
    >
      <select
        className="inspector-select"
        aria-label="Slide aspect ratio"
        value={presetOf(frame)}
        onChange={(event) => {
          const option = slideSizes.find(
            (option) => option.label === event.target.value,
          );
          if (option)
            update(frame.width, (frame.width * option.height) / option.width);
        }}
      >
        {slideSizes.map((option) => (
          <option key={option.label}>{option.label}</option>
        ))}
        <option value="custom">Custom</option>
      </select>
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
      >
        <button
          className="slides-button"
          disabled={!changed || !validSize(size.width, size.height)}
          onClick={() => update(size.width, size.height)}
          title="Resize the frame. Its contents keep their size and position."
        >
          Apply
        </button>
      </SizeInputs>
    </Field>
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
              aria-label={`Reveal step ${rank}: ${buildLabel(slide, element)}`}
              title={`Reveal step ${rank}: ${buildLabel(slide, element)}`}
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
      aria-label="Reveal preview"
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
          aria-label="Previous reveal step"
          onClick={() => setStep(level - 1)}
        >
          <Icon name="previous" size={14} />
        </button>
        <span role="status" aria-live="polite">
          {level === 0
            ? "Before step 1"
            : `Step ${level} of ${slide.steps.length}`}
        </span>
        <button
          className="icon-button"
          disabled={level === slide.steps.length}
          aria-label="Next reveal step"
          onClick={() => setStep(level + 1)}
        >
          <Icon name="next" size={14} />
        </button>
      </div>
    </div>
  );
}

function SlideGuides({
  slide,
  state,
}: {
  slide: Slide<ExcalidrawElement>;
  state: AppState;
}) {
  const frame = slide.frame,
    area = safeArea(frame),
    zoom = state.zoom.value;
  return createPortal(
    <div
      className="slide-guides"
      style={{
        left: state.offsetLeft,
        top: state.offsetTop,
        width: state.width,
        height: state.height,
      }}
      aria-hidden="true"
    >
      <div
        className="slide-safe-area"
        style={{
          left: (area.x + state.scrollX) * zoom,
          top: (area.y + state.scrollY) * zoom,
          width: area.width * zoom,
          height: area.height * zoom,
        }}
      />
      <div
        className="slide-center vertical"
        style={{
          left: (frame.x + frame.width / 2 + state.scrollX) * zoom,
          top: (frame.y + state.scrollY) * zoom,
          height: frame.height * zoom,
        }}
      />
      <div
        className="slide-center horizontal"
        style={{
          left: (frame.x + state.scrollX) * zoom,
          top: (frame.y + frame.height / 2 + state.scrollY) * zoom,
          width: frame.width * zoom,
        }}
      />
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

function SlideAlignment({
  slide,
  selected,
  api,
}: {
  slide: Slide<ExcalidrawElement>;
  selected: ExcalidrawElement[];
  api: ExcalidrawImperativeAPI;
}) {
  const targets = buildTargets(slide, selected);
  function align(value: string) {
    if (!targets.length) return;
    const [left, top, right, bottom] = getCommonBounds(targets);
    const area = safeArea(slide.frame);
    const dx =
      value === "left"
        ? area.x - left
        : value === "center"
          ? area.x + area.width / 2 - (left + right) / 2
          : value === "right"
            ? area.x + area.width - right
            : 0;
    const dy =
      value === "top"
        ? area.y - top
        : value === "middle"
          ? area.y + area.height / 2 - (top + bottom) / 2
          : value === "bottom"
            ? area.y + area.height - bottom
            : 0;
    const ids = new Set(targets.map((element) => element.id));
    for (const element of slide.elements)
      if (
        "containerId" in element &&
        element.containerId &&
        ids.has(element.containerId)
      )
        ids.add(element.id);
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          ids.has(element.id)
            ? newElementWith(element, { x: element.x + dx, y: element.y + dy })
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  return (
    <Field label="Align selection to safe area">
      <div className="slide-align-buttons">
        {["left", "center", "right", "top", "middle", "bottom"].map((value) => (
          <button
            className="slides-button"
            key={value}
            disabled={!targets.length}
            onClick={() => align(value)}
            title={
              targets.length
                ? undefined
                : "Select objects on this slide to align them"
            }
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
    </Field>
  );
}

function DeckSettings({
  deck,
  onChange,
  onApply,
  hasSlides,
}: {
  deck: DeckDefaults;
  onChange: (patch: Partial<DeckDefaults>) => void;
  onApply: (kind: "size" | "transition" | "effect") => void;
  hasSlides: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [size, setSize] = useState(deck.size ?? DEFAULT_SIZE);
  useEffect(() => {
    if (deck.size) setSize(deck.size);
  }, [deck.size?.width, deck.size?.height]);
  const preset = !deck.size
    ? "auto"
    : custom
      ? "custom"
      : (slideSizes.find(
          (option) =>
            option.width === deck.size!.width &&
            option.height === deck.size!.height,
        )?.label ?? "custom");
  const applyAll = (kind: "size" | "transition" | "effect", disabled = false) => (
    <button
      className="link-button"
      disabled={!hasSlides || disabled}
      onClick={() => onApply(kind)}
    >
      Apply to all
    </button>
  );
  return (
    <section className="deck-settings" aria-label="Deck settings">
      <p className="hint">
        Defaults for new slides and reveal steps. Apply to all to update
        existing ones.
      </p>
      <Field label="Slide size" action={applyAll("size", !deck.size)}>
        <select
          className="inspector-select"
          aria-label="Default slide size"
          value={preset}
          onChange={(event) => {
            const value = event.target.value;
            setCustom(value === "custom");
            if (value === "auto") onChange({ size: null });
            const option = slideSizes.find((option) => option.label === value);
            if (option)
              onChange({ size: { width: option.width, height: option.height } });
          }}
        >
          <option value="auto">Same as selected slide</option>
          {slideSizes.map((option) => (
            <option key={option.label}>{option.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
        {preset === "custom" && (
          <SizeInputs {...size} onChange={setSize}>
            <button
              className="slides-button"
              disabled={
                !validSize(size.width, size.height) ||
                (size.width === deck.size?.width &&
                  size.height === deck.size?.height)
              }
              onClick={() => onChange({ size })}
            >
              Set
            </button>
          </SizeInputs>
        )}
      </Field>
      <Field label="Transition" action={applyAll("transition")}>
        <Segmented
          label="Default transition"
          value={deck.transition}
          options={transitions.map((value) => ({
            value,
            label: transitionLabels[value],
          }))}
          onChange={(transition) => onChange({ transition })}
        />
        {deck.transition !== "cut" && (
          <Segmented
            label="Default transition speed"
            value={deck.duration}
            options={speeds.map(({ label, duration }) => ({
              value: duration,
              label,
            }))}
            onChange={(duration) => onChange({ duration })}
          />
        )}
      </Field>
      <Field label="Reveal effect" action={applyAll("effect")}>
        <Segmented
          label="Default reveal effect"
          value={deck.effect}
          options={effects.map((value) => ({
            value,
            label: effectLabels[value],
          }))}
          onChange={(effect) => onChange({ effect })}
        />
      </Field>
    </section>
  );
}
