import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import {
  Excalidraw,
  FONT_FAMILY,
  hashElementsVersion,
  newElementWith,
  loadFromBlob,
  MainMenu,
  CaptureUpdateAction,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import {
  createWriteQueue,
  fileName,
  isWithin,
  parentPath,
  parseRecovery,
  remapPath,
  serializeRecovery,
  validateDrawing,
} from "./document";
import { cssFamily, fontId, lineHeight, type SystemFont } from "./fonts";
import { Icon, type IconName } from "./icons";
import { getSlides, withSlide, withBuild, fit, isFrame, readSlide, lockedFrameBounds, type SceneElement } from "./presentation";
import { applyView, convert, patchElements } from "./mcp-editor";
import { parseElements, slidesSchema, slideSkeletons, settingsSchema, buildSchema, filesSchema } from "./mcp-schema";
import Presenter from "./Presenter";
import { SlidesPanel, SlidesTrigger } from "./SlidesPanel";
import {
  createDrawing,
  createFolder,
  deleteEntry,
  desktop,
  forgetDocument,
  listFonts,
  openDocument,
  readDrawing,
  readLinked,
  readRecovery,
  readWorkspace,
  renameEntry,
  saveDocument,
  writeRecovery,
  type Entry,
  type LinkedDocument,
  type Workspace,
} from "./storage";

type Choice = "save" | "discard" | "cancel";

// What the presenter shows: a snapshot of the drawing taken when the presentation starts.
type Presentation = Pick<
  ComponentProps<typeof Presenter>,
  "elements" | "files" | "background" | "start"
> & { doc: Doc };

// An open drawing. Async file flows read these fields after awaits, so they live outside React state.
type Doc = {
  id: number;
  mcpId: string;
  path: string | null;
  dirty: boolean;
  data: ExcalidrawInitialDataState | null;
  api: ExcalidrawImperativeAPI | null;
  fingerprint: string | null;
  revision: number;
  frames: Map<string, SceneElement>;
  timer: ReturnType<typeof setTimeout> | null;
  // What recovery holds for this drawing; only set while it has unsaved edits.
  snapshot: string | null;
};

let lastId = 0;

function createDoc(
  data: ExcalidrawInitialDataState | null = null,
  path: string | null = null,
): Doc {
  return {
    id: ++lastId,
    mcpId: crypto.randomUUID(),
    path,
    dirty: false,
    data,
    api: null,
    fingerprint: null,
    revision: 0,
    frames: new Map(),
    timer: null,
    snapshot: null,
  };
}

const displayName = (path: string | null) =>
  fileName(path).replace(/\.excalidraw$/, "");

export default function App() {
  const [ready, setReady] = useState(false);
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [initial] = useState(createDoc);
  const docs = useRef<Doc[]>([initial]);
  const activeId = useRef(initial.id);
  const focusPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many unsaved drawings were restored at startup, until the notice is dismissed.
  const [recovered, setRecovered] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [sidebar, setSidebar] = useState(true);
  const [theme, setTheme, themePreference] = useTheme();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Where new drawings and folders go; null means the top of the drawings folder.
  const [folder, setFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [linked, setLinked] = useState<LinkedDocument[]>([]);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  // Read by the window-level listeners, which keep their first closure.
  const presenting = useRef(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const busyRef = useRef(false);
  const queue = useRef(createWriteQueue());
  const resolvePrompt = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLElement | null>(null);
  const handlers = useRef({
    new: () => {},
    open: () => {},
    save: (_as?: boolean) => {},
    close: () => {},
    openEntry: (_path: string) => {},
    forget: (_path: string) => {},
    newFolder: (_parent?: string) => {},
    rename: (_entry: Entry, _name: string | null) => {},
    remove: (_entry: Entry) => {},
    select: (_doc: Doc) => {},
    cycle: (_step: number) => {},
    selectNth: (_number: number) => {},
    closeTab: (_doc?: Doc) => {},
    closeOthers: (_doc: Doc) => {},
    present: (_start?: string | null) => {},
    endPresentation: (_frameId?: string) => {},
  });
  const mounted = useRef(true);

  function report(reason: unknown) {
    if (mounted.current)
      setError(reason instanceof Error ? reason.message : String(reason));
  }

  useEffect(() => {
    if (desktop) void getCurrentWindow().setTheme(themePreference).catch(report);
  }, [themePreference]);

  function current() {
    return (
      docs.current.find((doc) => doc.id === activeId.current) ?? docs.current[0]
    );
  }

  function activate(doc: Doc) {
    if (doc.id === activeId.current) return;
    activeId.current = doc.id;
    focusPending.current = true;
    render();
  }

  function stopTimer(doc: Doc) {
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = null;
  }

  function serialize(doc: Doc) {
    if (!doc.api)
      throw new Error("The editor is still loading. Please try again.");
    return serializeAsJSON(
      doc.api.getSceneElements(),
      doc.api.getAppState(),
      doc.api.getFiles(),
      "local",
    );
  }

  // Recovery holds every drawing with unsaved edits, so it is rewritten whenever one of them changes.
  function writeSnapshots() {
    const data = serializeRecovery(
      docs.current.flatMap((doc) =>
        doc.snapshot
          ? [{ name: fileName(doc.path), drawing: doc.snapshot }]
          : [],
      ),
    );
    return queue.current(() => writeRecovery(data));
  }

  async function persistRecovery(targets: Doc[]) {
    for (const doc of targets) {
      stopTimer(doc);
      // A restored drawing keeps its recovered snapshot until its editor has loaded.
      if (!doc.dirty) doc.snapshot = null;
      else if (doc.api) doc.snapshot = serialize(doc);
    }
    await writeSnapshots();
  }

  const onChange =
    (doc: Doc): NonNullable<ExcalidrawProps["onChange"]> =>
    (elements, appState) => {
      const previous = doc.frames;
      doc.frames = new Map(elements.filter(isFrame).map((element) => [element.id, element]));
      if (appState.isResizing && doc.api) {
        let changed = false;
        const resized = elements.map((element) => {
          const before = previous.get(element.id);
          const ratio = isFrame(element) ? readSlide(element).aspectRatio : null;
          if (!before || !ratio || !appState.selectedElementIds[element.id] ||
              Math.abs(element.width / Math.max(element.height, 1) - ratio) < 0.0001) return element;
          changed = true;
          return newElementWith(element, lockedFrameBounds(before, element, ratio));
        });
        if (changed) {
          doc.api.updateScene({ elements: resized, captureUpdate: CaptureUpdateAction.EVENTUALLY });
          return;
        }
      }
      // Selection and panning are not document edits. No scene copies in React state.
      const next = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${appState.gridSize}:${appState.gridStep}:${appState.gridModeEnabled}`;
      if (doc.fingerprint === null) {
        doc.fingerprint = next;
        return;
      }
      if (next === doc.fingerprint) return;
      doc.fingerprint = next;
      doc.revision += 1;
      if (!doc.dirty) {
        doc.dirty = true;
        render();
      }
      stopTimer(doc);
      doc.timer = setTimeout(() => {
        void persistRecovery([doc]).catch(report);
      }, 800);
    };

  async function refresh() {
    if (!desktop) return;
    try {
      const [next, others] = await Promise.all([readWorkspace(), readLinked()]);
      if (mounted.current) {
        setWorkspace(next);
        setLinked(others);
      }
    } catch (reason) {
      report(reason);
    }
  }

  function reveal(target: string, root: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (
        let parent = parentPath(target);
        parent !== root && isWithin(parent, root);
        parent = parentPath(parent)
      )
        next.add(parent);
      return next;
    });
  }

  async function save(doc: Doc, as = false): Promise<boolean> {
    const savedRevision = doc.revision;
    const data = serialize(doc);
    const target =
      !as && !doc.path && workspace ? (folder ?? workspace.root) : null;
    const destination = target
      ? await createDrawing(target, data)
      : await saveDocument(as ? null : doc.path, data);
    if (!destination) return false;
    doc.path = destination;
    if (doc.revision === savedRevision) doc.dirty = false;
    render();
    setRecovered(0);
    if (workspace) reveal(destination, workspace.root);
    if (target) setRenaming(destination);
    void refresh();
    // The drawing was saved even if updating recovery fails.
    await persistRecovery([doc]).catch(report);
    return true;
  }

  async function canLeave(doc: Doc): Promise<boolean> {
    if (!doc.dirty) return true;
    activate(doc);
    setPrompt(displayName(doc.path));
    dialog.current?.showModal();
    const choice = await new Promise<Choice>((resolve) => {
      resolvePrompt.current = resolve;
    });
    if (choice === "cancel") return false;
    if (choice === "save") {
      if (!(await save(doc))) return false;
      // Edits made while the native save dialog was open also need protection.
      if (doc.dirty) return canLeave(doc);
    }
    return true;
  }

  function addDoc(
    data: ExcalidrawInitialDataState | null,
    path: string | null,
  ) {
    const list = docs.current;
    const index = list.indexOf(current());
    const active = list[index];
    // An untouched blank tab is replaced rather than left behind.
    const replace = !active.path && !active.dirty && active.revision === 0;
    if (replace) stopTimer(active);
    const doc = createDoc(data, path);
    list.splice(replace ? index : index + 1, replace ? 1 : 0, doc);
    activate(doc);
    return doc;
  }

  // Shows a drawing, switching to its tab when it is already open.
  async function show(path: string, text?: string) {
    // The browser preview only knows file names, which need not be unique.
    const open = desktop && docs.current.find((doc) => doc.path === path);
    if (open) return activate(open);
    text ??= await readDrawing(path);
    validateDrawing(text);
    addDoc(
      await loadFromBlob(
        new Blob([text], { type: "application/json" }),
        null,
        null,
      ),
      path,
    );
  }

  function drop(doc: Doc) {
    stopTimer(doc);
    const list = docs.current;
    const index = list.indexOf(doc);
    if (index < 0) return;
    list.splice(index, 1);
    if (!list.length) list.push(createDoc());
    if (doc.id === activeId.current)
      activate(list[Math.min(index, list.length - 1)]);
    else render();
  }

  async function closeTabs(targets: Doc[]) {
    for (const doc of targets) {
      if (!(await canLeave(doc))) break;
      drop(doc);
    }
    await writeSnapshots();
  }

  async function run(action: () => Promise<unknown>) {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      report(reason);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function select(doc: Doc | undefined) {
    if (doc && ready && !busyRef.current) activate(doc);
  }

  handlers.current = {
    new: () => {
      void run(async () => addDoc(null, null));
    },
    open: () => {
      void run(async () => {
        const file = await openDocument();
        if (!file) return;
        await show(file.path, file.data);
        await refresh();
      });
    },
    save: (as = false) => {
      void run(() => save(current(), as));
    },
    openEntry: (target: string) => {
      void run(async () => {
        await show(target);
        if (workspace && isWithin(target, workspace.root))
          setFolder(parentPath(target));
      });
    },
    forget: (target: string) => {
      void run(async () => {
        await forgetDocument(target);
        await refresh();
      });
    },
    newFolder: (parent?: string) => {
      void run(async () => {
        if (!workspace) return;
        const created = await createFolder(parent ?? folder ?? workspace.root);
        reveal(created, workspace.root);
        await refresh();
        setRenaming(created);
      });
    },
    remove: (entry: Entry) => {
      void run(async () => {
        await deleteEntry(entry.path);
        for (const doc of [...docs.current]) {
          if (!doc.path || !isWithin(doc.path, entry.path)) continue;
          // Unsaved edits stay open as an untitled drawing instead of disappearing with the file.
          if (doc.dirty) doc.path = null;
          else drop(doc);
        }
        render();
        setFolder((value) =>
          value && isWithin(value, entry.path) ? null : value,
        );
        setExpanded(
          (previous) =>
            new Set(
              [...previous].filter((value) => !isWithin(value, entry.path)),
            ),
        );
        await writeSnapshots();
        await refresh();
      });
    },
    rename: (entry: Entry, name: string | null) => {
      setRenaming(null);
      if (name === null || !name.trim() || name.trim() === entry.name) return;
      void run(async () => {
        const next = await renameEntry(entry.path, name);
        const move = (value: string) => remapPath(value, entry.path, next);
        for (const doc of docs.current) if (doc.path) doc.path = move(doc.path);
        render();
        setFolder((value) => value && move(value));
        setExpanded((previous) => new Set([...previous].map(move)));
        await refresh();
      });
    },
    select,
    cycle: (step: number) => {
      const list = docs.current;
      select(
        list[(list.indexOf(current()) + step + list.length) % list.length],
      );
    },
    // Like browsers, the ninth shortcut always goes to the last tab.
    selectNth: (number: number) =>
      select(number === 9 ? docs.current.at(-1) : docs.current[number - 1]),
    closeTab: (doc = current()) => {
      void run(() => closeTabs([doc]));
    },
    closeOthers: (doc: Doc) => {
      void run(() => closeTabs(docs.current.filter((other) => other !== doc)));
    },
    present: (start = null) => {
      const doc = current();
      if (!ready || busyRef.current || presenting.current || !doc.api) return;
      const elements = doc.api.getSceneElements();
      if (!getSlides(elements).length)
        return setError("Add a frame (F) to make a slide.");
      setError(null);
      presenting.current = true;
      setPresentation({
        doc,
        elements,
        files: doc.api.getFiles(),
        background: doc.api.getAppState().viewBackgroundColor,
        start,
      });
    },
    // The editor comes back showing the slide the presentation ended on.
    endPresentation: (frameId?: string) => {
      if (!presenting.current) return;
      presenting.current = false;
      const api = presentation?.doc.api;
      setPresentation(null);
      const frame =
        frameId &&
        api?.getSceneElements().find((element) => element.id === frameId);
      if (api && frame)
        api.scrollToContent(frame, {
          fitToViewport: true,
          viewportZoomFactor: 0.9,
        });
      focusPending.current = true;
    },
    close: () => {
      void run(async () => {
        for (const doc of [...docs.current]) if (!(await canLeave(doc))) return;
        for (const doc of docs.current) stopTimer(doc);
        await queue.current(() => writeRecovery(null));
        if (desktop) await invoke("close_app");
      });
    },
  };

  const mcpHandler = useRef<(method: string, params: any) => Promise<unknown>>(async () => { throw new Error("Editor is loading"); });
  mcpHandler.current = async (method, params) => {
    if (!ready || busyRef.current || presenting.current || resolvePrompt.current)
      throw new Error("Editor is busy. Finish the current operation or presentation, then retry.");
    const target = (id?: string) => {
      const doc = id ? docs.current.find((doc) => doc.mcpId === id) : current();
      if (!doc) throw new Error("Document not found. Use list_documents for current IDs.");
      return doc;
    };
    const drawing = (doc: Doc): any => doc.api ? JSON.parse(serialize(doc)) : {
      type: "excalidraw", version: 2, source: "excali-desktop", elements: doc.data?.elements ?? [],
      appState: doc.data?.appState ?? {}, files: doc.data?.files ?? {},
    };
    const describe = (doc: Doc) => ({ documentId: doc.mcpId, checkpointId: doc.mcpId, path: doc.path, dirty: doc.dirty });
    const scene = (doc: Doc) => ({ ...describe(doc), ...drawing(doc) });
    const changed = async (doc: Doc) => {
      doc.dirty = true;
      doc.revision += 1;
      stopTimer(doc);
      doc.snapshot = JSON.stringify(drawing(doc));
      render();
      await writeSnapshots();
    };
    const waitForEditor = async (doc: Doc) => {
      const deadline = Date.now() + 5000;
      while (!doc.api && docs.current.includes(doc) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!doc.api) throw new Error("This tab is still loading. Retry shortly.");
      return doc.api;
    };
    const update = async (doc: Doc, elements: ReturnType<typeof convert>) => {
      await waitForEditor(doc);
      if (!doc.api) throw new Error("Editor closed during the operation");
      doc.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      await changed(doc);
    };
    if (method === "list_documents") return { documents: docs.current.map(describe), activeDocumentId: current().mcpId };
    if (method === "list_drawings") return readWorkspace();
    if (method === "get_scene") return scene(target(params.documentId));
    if (method === "read_checkpoint") return scene(target(params.id));
    if (method === "open_drawing") {
      // Agents can open only workspace files, never arbitrary paths or native dialogs.
      const tree = await readWorkspace();
      const find = (entries: Entry[]): boolean => entries.some((entry) => entry.folder ? find(entry.children) : entry.path === params.path);
      if (!find(tree.entries)) throw new Error("Choose a drawing path returned by list_drawings");
      await show(params.path);
      return describe(current());
    }
    if (method === "import_drawing") {
      validateDrawing(params.json);
      const data = await loadFromBlob(new Blob([params.json], { type: "application/json" }), null, null);
      const imported = addDoc(data, null);
      await changed(imported);
      await waitForEditor(imported);
      return describe(imported);
    }
    if (method === "create_view") {
      const input = parseElements(params.elements);
      const checkpoint = input.find((element) => element.type === "restoreCheckpoint");
      const doc = checkpoint ? target(checkpoint.id) : null;
      const result = applyView(params.elements, doc ? drawing(doc).elements : []);
      const view = current().api?.getAppState();
      const camera = result.camera && view ? fit(result.camera, view) : null;
      const destination = doc ?? addDoc({ elements: result.elements, appState: camera ? { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: { value: camera.zoom as any } } : undefined }, null);
      if (doc) await update(doc, result.elements);
      else { await changed(destination); await waitForEditor(destination); }
      if (result.camera && destination.api) {
        const state = destination.api.getAppState();
        const camera = fit(result.camera, { width: state.width, height: state.height });
        destination.api.updateScene({ appState: { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: { value: camera.zoom as any } }, captureUpdate: CaptureUpdateAction.NEVER });
      }
      return describe(destination);
    }
    if (method === "create_slides") {
      const slides = slidesSchema.parse(params.slides);
      const doc = params.documentId ? target(params.documentId) : null;
      const existing = doc ? drawing(doc).elements : [];
      const offset = getSlides(existing).length;
      const startX = doc ? Math.max(0, ...existing.map((element: any) => element.x + element.width + 120)) : 0;
      const added = convert(slideSkeletons(slides, offset, startX));
      const existingIds = new Set(existing.map((element: any) => element.id));
      if (added.some((element) => existingIds.has(element.id))) throw new Error("A slide element id already exists in this drawing");
      const view = current().api?.getAppState();
      const first = getSlides(added)[0]?.frame;
      const camera = first && view ? fit(first, { width: view.width * 0.9, height: view.height * 0.9 }) : null;
      const destination = doc ?? addDoc({ elements: added, appState: camera ? { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: { value: camera.zoom as any } } : undefined }, null);
      if (doc) await update(doc, [...existing, ...added]);
      else { await changed(destination); await waitForEditor(destination); }
      return { ...describe(destination), slides: getSlides(added).map((slide) => ({ frameId: slide.frame.id, settings: slide.settings })) };
    }
    const doc = target(params.documentId);
    if (method === "save_document") {
      const data = JSON.stringify(drawing(doc));
      const revision = doc.revision;
      if (doc.path) await saveDocument(doc.path, data);
      else {
        // Create a unique file using the same native persistence as the Save button.
        const tree = await readWorkspace();
        doc.path = await createDrawing(tree.root, data, params.name);
      }
      if (doc.revision === revision) { doc.dirty = false; doc.snapshot = null; }
      await writeSnapshots();
      render();
      await refresh();
      return describe(doc);
    }
    await waitForEditor(doc);
    if (!doc.api) throw new Error("Editor closed during the operation");
    if (method === "add_files") {
      const files = filesSchema.parse(params.files).map((file) => ({ ...file, created: file.created ?? Date.now() }));
      doc.api.addFiles(files as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
      await changed(doc);
      return describe(doc);
    }
    const elements = doc.api.getSceneElements();
    if (method === "update_elements") {
      await update(doc, patchElements(elements, params.updates, params.deleteIds));
      return describe(doc);
    }
    if (method === "update_slide") {
      const slide = getSlides(elements).find((slide) => slide.frame.id === params.frameId);
      if (!slide) throw new Error("Slide frame not found");
      const updates: Record<string, any>[] = [{ id: slide.frame.id, customData: withSlide(slide.frame.customData, settingsSchema.parse(params.settings)) }];
      for (const item of params.builds) {
        const element = slide.elements.find((element) => element.id === item.elementId);
        if (!element) throw new Error(`Element is not on this slide: ${item.elementId}`);
        updates.push({ id: element.id, customData: withBuild(element.customData, item.build === null ? null : buildSchema.parse(item.build)) });
      }
      await update(doc, patchElements(elements, updates, []));
      return describe(doc);
    }
    if (method === "export_scene") {
      const slide = params.frameId ? getSlides(elements).find((slide) => slide.frame.id === params.frameId) : null;
      if (params.frameId && !slide) throw new Error("Slide frame not found");
      const options = { elements: slide ? [slide.frame, ...slide.elements] : elements, files: doc.api.getFiles(), appState: { ...doc.api.getAppState(), exportBackground: true, exportWithDarkMode: false }, exportingFrame: slide?.frame as any };
      if (params.format === "svg") return { mimeType: "image/svg+xml", data: (await exportToSvg(options)).outerHTML };
      const blob = await exportToBlob({ ...options, mimeType: "image/png" });
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not encode exported image"));
        reader.readAsDataURL(blob);
      });
      return { mimeType: "image/png", data };
    }
    throw new Error(`Unknown desktop operation: ${method}`);
  };

  useEffect(() => {
    if (!desktop || !ready) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ id: string; method: string; params: any }>("mcp-request", async ({ payload }) => {
      let result: unknown;
      try { result = await mcpHandler.current(payload.method, payload.params); }
      catch (reason) { result = { error: reason instanceof Error ? reason.message : String(reason) }; }
      await invoke("mcp_reply", { id: payload.id, result }).catch(report);
    }).then(async (unlisten) => {
      if (disposed) return unlisten();
      stop = unlisten;
      await invoke("start_mcp");
    }).catch(report);
    return () => { disposed = true; stop?.(); };
  }, [ready]);

  function answer(choice: Choice) {
    dialog.current?.close();
    resolvePrompt.current?.(choice);
    resolvePrompt.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      // Fonts are registered before the first render so saved text never draws in a fallback font.
      const fonts = listFonts().then(registerSystemFonts).catch(report);
      try {
        const saved = await readRecovery();
        await fonts;
        if (saved) {
          const restored = await Promise.all(
            parseRecovery(saved).map(async ({ drawing }) => {
              const doc = createDoc(
                await loadFromBlob(
                  new Blob([drawing], { type: "application/json" }),
                  null,
                  null,
                ),
              );
              doc.dirty = true;
              doc.snapshot = drawing;
              return doc;
            }),
          );
          if (cancelled || !restored.length) return;
          docs.current = restored;
          activeId.current = restored[0].id;
          setRecovered(restored.length);
        }
      } catch (reason) {
        report(reason);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    // Pick up drawings added or moved in Finder while the app was in the background.
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      mounted.current = false;
      for (const doc of docs.current) stopTimer(doc);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // The presenter handles its own keys.
      if (presenting.current) return;
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key === "Tab"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handlers.current.cycle(event.shiftKey ? -1 : 1);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const tab = !event.shiftKey && /^[1-9]$/.test(key);
      const play = event.shiftKey && key === "p";
      if (!tab && !play && !["n", "o", "s"].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (tab) handlers.current.selectNth(Number(key));
      if (play) handlers.current.present();
      if (key === "s") handlers.current.save(event.shiftKey);
      if (key === "o") handlers.current.open();
      if (key === "n") handlers.current.new();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (docs.current.some((doc) => doc.dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const visibility = () => {
      const pending = docs.current.filter((doc) => doc.timer);
      if (document.visibilityState === "hidden" && pending.length)
        void persistRecovery(pending).catch(report);
    };
    // The webview's Reload / Inspect Element menu is only useful in text fields (for copy and paste).
    const contextMenu = (event: MouseEvent) => {
      if (
        desktop &&
        !(event.target as Element).closest?.(
          "input, textarea, [contenteditable]",
        )
      )
        event.preventDefault();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("contextmenu", contextMenu);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    const stops: (() => void)[] = [];
    let disposed = false;
    const keep = (subscription: Promise<() => void>) => {
      void subscription
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch(report);
    };
    if (desktop) {
      // Closing ends a presentation first so the unsaved-changes dialog isn't hidden behind it.
      const close = () => {
        handlers.current.endPresentation();
        handlers.current.close();
      };
      keep(
        getCurrentWindow().onCloseRequested((event) => {
          event.preventDefault();
          close();
        }),
      );
      keep(listen("request-close", close));
      // Cmd/Ctrl+W comes from the native menu, which would otherwise close the window.
      keep(
        listen("close-tab", () =>
          presenting.current
            ? handlers.current.endPresentation()
            : handlers.current.closeTab(),
        ),
      );
    }
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const active = current();
  const path = active.path;
  const dirty = active.dirty;
  const title = displayName(path);

  useEffect(() => {
    const text = `${dirty ? "● " : ""}${title} — Excali Desktop`;
    document.title = text;
    if (desktop) void getCurrentWindow().setTitle(text).catch(report);
  }, [title, dirty]);

  useEffect(() => {
    // The editor is inert while busy, so focus waits until the file operation is done.
    if (busy || !focusPending.current) return;
    focusPending.current = false;
    active.api?.refresh();
    editor.current
      ?.querySelector<HTMLElement>(".canvas.active .excalidraw-container")
      ?.focus();
  });

  const disabled = busy || !ready;
  const edited = new Set(
    docs.current.flatMap((doc) => (doc.dirty && doc.path ? [doc.path] : [])),
  );
  const toggle = (
    <button
      className="icon-button"
      onClick={() => setSidebar(!sidebar)}
      aria-label={sidebar ? "Hide sidebar" : "Show sidebar"}
      aria-expanded={sidebar}
      title={sidebar ? "Hide sidebar" : "Show sidebar"}
    >
      <Icon name="sidebar" />
    </button>
  );
  return (
    <div className={`app ${mac ? "mac" : ""}`} data-theme={theme}>
      {sidebar && (
        <aside
          className="sidebar"
          aria-label="Sidebar"
          ref={(element) => {
            if (element) element.inert = !!presentation;
          }}
        >
          <div className="sidebar-header" data-tauri-drag-region>
            {toggle}
            <button
              className="icon-button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
          <nav className="sidebar-nav" aria-label="File">
            <SidebarItem
              icon="new"
              label="New"
              shortcut={`${command}N`}
              disabled={disabled}
              onClick={() => handlers.current.new()}
            />
            <SidebarItem
              icon="open"
              label="Open…"
              shortcut={`${command}O`}
              disabled={disabled}
              onClick={() => handlers.current.open()}
            />
            <SidebarItem
              icon="save"
              label="Save"
              shortcut={`${command}S`}
              disabled={disabled}
              onClick={() => handlers.current.save()}
            />
            <SidebarItem
              icon="saveAs"
              label="Save as…"
              shortcut={`⇧${command}S`}
              disabled={disabled}
              onClick={() => handlers.current.save(true)}
            />
            <SidebarItem
              icon="play"
              label="Present"
              shortcut={`⇧${command}P`}
              disabled={disabled}
              onClick={() => handlers.current.present()}
            />
          </nav>
          <div className="sidebar-heading">
            <button
              className="heading-label"
              disabled={!workspace}
              onClick={() => setFolder(null)}
              title={workspace?.root}
            >
              Drawings
            </button>
            {workspace && (
              <button
                className="icon-button"
                disabled={disabled}
                onClick={() => handlers.current.newFolder()}
                aria-label="New folder"
                title="New folder"
              >
                <Icon name="folderPlus" />
              </button>
            )}
          </div>
          <div className="tree" role="tree" aria-label="Drawings">
            {(!path ||
              !workspace ||
              (!isWithin(path, workspace.root) &&
                !linked.some((item) => item.path === path))) && (
              <div
                className="tree-row active"
                style={{ "--depth": 0 } as CSSProperties}
              >
                <div className="sidebar-item" title={path || undefined}>
                  <Icon name="file" />
                  <span className="label">{title}</span>
                  {dirty && (
                    <span className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                </div>
              </div>
            )}
            {workspace && (
              <Tree
                entries={workspace.entries}
                depth={0}
                tree={{
                  path,
                  edited,
                  expanded,
                  folder,
                  renaming,
                  disabled,
                  open: (entry) => {
                    if (!entry.folder)
                      return handlers.current.openEntry(entry.path);
                    setFolder(entry.path);
                    setExpanded((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(entry.path)) next.add(entry.path);
                      return next;
                    });
                  },
                  startRename: (entry) => setRenaming(entry.path),
                  rename: (entry, name) => handlers.current.rename(entry, name),
                  menu: (entry) =>
                    showMenu(
                      [
                        entry.folder
                          ? {
                              text: "New Folder",
                              action: () =>
                                handlers.current.newFolder(entry.path),
                            }
                          : {
                              text: "Open",
                              enabled: entry.path !== path,
                              action: () =>
                                handlers.current.openEntry(entry.path),
                            },
                        {
                          text: "Rename",
                          action: () => setRenaming(entry.path),
                        },
                        { item: "Separator" },
                        {
                          text: "Move to Trash",
                          action: () => handlers.current.remove(entry),
                        },
                      ],
                      report,
                    ),
                }}
              />
            )}
            {linked.length > 0 && (
              <>
                <h2 className="sidebar-heading">Other locations</h2>
                {linked.map((item) => {
                  const isActive = item.path === path;
                  return (
                    <div
                      key={item.path}
                      className={`tree-row ${isActive ? "active" : ""} ${item.missing ? "missing" : ""}`}
                      style={{ "--depth": 0 } as CSSProperties}
                    >
                      <button
                        className="sidebar-item"
                        role="treeitem"
                        aria-current={isActive || undefined}
                        disabled={disabled}
                        title={
                          item.missing ? `Not found: ${item.path}` : item.path
                        }
                        onClick={() => handlers.current.openEntry(item.path)}
                        onContextMenu={() => {
                          if (!disabled)
                            showMenu(
                              [
                                {
                                  text: "Open",
                                  enabled: !isActive && !item.missing,
                                  action: () =>
                                    handlers.current.openEntry(item.path),
                                },
                                { item: "Separator" },
                                {
                                  text: "Remove from Sidebar",
                                  action: () =>
                                    handlers.current.forget(item.path),
                                },
                              ],
                              report,
                            );
                        }}
                      >
                        <Icon name="file" />
                        <span className="label">{item.name}</span>
                        {edited.has(item.path) ? (
                          <span
                            className="dirty-dot"
                            aria-label="Unsaved changes"
                          />
                        ) : (
                          <span className="hint">{item.location}</span>
                        )}
                      </button>
                      <button
                        className="icon-button rename"
                        disabled={disabled}
                        onClick={() => handlers.current.forget(item.path)}
                        aria-label={`Remove ${item.name} from sidebar`}
                        title="Remove from sidebar"
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </aside>
      )}
      <div
        className="main"
        ref={(element) => {
          if (element) element.inert = !!presentation;
        }}
      >
        <header className="titlebar" data-tauri-drag-region>
          {!sidebar && toggle}
          <div
            className="tabs"
            role="tablist"
            aria-label="Open drawings"
            data-tauri-drag-region
          >
            {docs.current.map((doc) => {
              const selected = doc === active;
              const name = displayName(doc.path);
              return (
                <div
                  key={doc.id}
                  className={`tab ${selected ? "active" : ""} ${doc.dirty ? "dirty" : ""}`}
                  title={doc.path || name}
                  onAuxClick={(event) => {
                    if (event.button === 1 && !disabled)
                      handlers.current.closeTab(doc);
                  }}
                  onContextMenu={() => {
                    if (!disabled)
                      showMenu(
                        [
                          {
                            text: "Close Tab",
                            action: () => handlers.current.closeTab(doc),
                          },
                          {
                            text: "Close Other Tabs",
                            enabled: docs.current.length > 1,
                            action: () => handlers.current.closeOthers(doc),
                          },
                        ],
                        report,
                      );
                  }}
                >
                  <button
                    className="tab-label"
                    role="tab"
                    aria-selected={selected}
                    disabled={disabled}
                    onClick={() => handlers.current.select(doc)}
                  >
                    <span className="label">{name}</span>
                  </button>
                  {doc.dirty && (
                    <span className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                  <button
                    className="icon-button tab-close"
                    disabled={disabled}
                    onClick={() => handlers.current.closeTab(doc)}
                    aria-label={`Close ${name}`}
                    title={desktop ? `Close tab (${command}W)` : "Close tab"}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
            <button
              className="icon-button"
              disabled={disabled}
              onClick={() => handlers.current.new()}
              aria-label="New drawing"
              title={`New drawing (${command}N)`}
            >
              <Icon name="plus" />
            </button>
          </div>
        </header>
        <main
          className="editor"
          aria-label="Drawing editor"
          aria-busy={busy}
          ref={(element) => {
            editor.current = element;
            if (element) element.inert = busy || !!presentation;
          }}
          onDropCapture={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            event.stopPropagation();
            setError(`Use Open (${command}O) to open drawings.`);
          }}
        >
          <div className="canvases">
          {/* Every open drawing keeps its editor, and with it its undo history; only the active one is shown. */}
          {ready &&
            docs.current.map((doc) => (
              <div
                key={doc.id}
                className={`canvas ${doc === active ? "active" : ""}`}
                ref={(element) => {
                  if (element) element.inert = doc !== active;
                }}
              >
                <Excalidraw
                  initialData={doc.data}
                  excalidrawAPI={(value) => {
                    doc.api = value;
                  }}
                  onChange={onChange(doc)}
                  theme={theme}
                  UIOptions={{
                    canvasActions: {
                      loadScene: false,
                      saveToActiveFile: false,
                      export: { saveFileToDisk: false },
                      toggleTheme: false,
                    },
                  }}
                  renderTopRightUI={() => (
                    <SlidesTrigger
                      open={slidesOpen}
                      onToggle={() => setSlidesOpen(!slidesOpen)}
                      onPlay={() => handlers.current.present()}
                    />
                  )}
                >
                  <MainMenu>
                    <MainMenu.DefaultItems.Export />
                    <MainMenu.DefaultItems.ClearCanvas />
                    <MainMenu.DefaultItems.ChangeCanvasBackground />
                  </MainMenu>
                </Excalidraw>
              </div>
            ))}
          {(error || recovered > 0) && (
            <div
              className={`toast ${error ? "error" : ""}`}
              role={error ? "alert" : "status"}
            >
              <span>
                {error ||
                  (recovered > 1
                    ? `Restored ${recovered} unsaved drawings.`
                    : "Restored your unsaved drawing.")}
              </span>
              <button
                className="icon-button"
                onClick={() => (error ? setError(null) : setRecovered(0))}
                aria-label="Dismiss"
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          </div>
          {ready && slidesOpen && (
            <SlidesPanel
              key={active.id}
              getApi={() => active.api}
              onPlay={(start) => handlers.current.present(start)}
              onClose={() => setSlidesOpen(false)}
              onEditorKey={({ key, code, metaKey, ctrlKey, shiftKey, altKey }) => {
                editor.current
                  ?.querySelector(".canvas.active .excalidraw-container")
                  ?.dispatchEvent(new KeyboardEvent("keydown", { key, code, metaKey, ctrlKey, shiftKey, altKey, bubbles: true }));
              }}
            />
          )}
        </main>
      </div>
      <dialog
        ref={dialog}
        className="unsaved-dialog"
        onCancel={(event) => {
          event.preventDefault();
          answer("cancel");
        }}
        aria-labelledby="unsaved-title"
      >
        <h2 id="unsaved-title">Save changes to “{prompt}”?</h2>
        <div className="dialog-actions">
          <button onClick={() => answer("discard")}>Don’t save</button>
          <span />
          <button onClick={() => answer("cancel")} autoFocus>
            Cancel
          </button>
          <button className="primary" onClick={() => answer("save")}>
            Save
          </button>
        </div>
      </dialog>
      {presentation && (
        <Presenter
          elements={presentation.elements}
          files={presentation.files}
          background={presentation.background}
          start={presentation.start}
          theme={theme}
          onExit={(frameId) => handlers.current.endPresentation(frameId)}
        />
      )}
    </div>
  );
}

const command = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
const mac = desktop && navigator.platform.includes("Mac");

type FontRegistry = {
  registered: Map<
    number,
    { metadata: object; fontFaces: { fontFace: { family: string } }[] }
  >;
};

// Excalidraw maps font ids to CSS through FONT_FAMILY, and its font picker lists the registry
// that vite.config.ts exposes. Local fonts are skipped when Excalidraw loads or embeds font files.
function registerSystemFonts(fonts: SystemFont[]) {
  const registry = (globalThis as { __excalidrawFonts?: FontRegistry })
    .__excalidrawFonts;
  if (!registry)
    throw new Error("Installed fonts could not be added to the font picker.");
  const families = FONT_FAMILY as Record<string, number>;
  for (const font of fonts) {
    if (font.family in families) continue;
    const id = fontId(font.family);
    families[cssFamily(font.family)] = id;
    registry.registered.set(id, {
      metadata: {
        local: true,
        metrics: {
          unitsPerEm: font.unitsPerEm,
          ascender: font.ascender,
          descender: font.descender,
          lineHeight: lineHeight(font),
        },
      },
      fontFaces: [{ fontFace: { family: font.family } }],
    });
  }
}

function SidebarItem({
  icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className="sidebar-item" disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      <span className="label">{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}

type TreeContext = {
  path: string | null;
  edited: Set<string>;
  expanded: Set<string>;
  folder: string | null;
  renaming: string | null;
  disabled: boolean;
  open: (entry: Entry) => void;
  startRename: (entry: Entry) => void;
  rename: (entry: Entry, name: string | null) => void;
  menu: (entry: Entry) => void;
};

function Tree({
  entries,
  depth,
  tree,
}: {
  entries: Entry[];
  depth: number;
  tree: TreeContext;
}) {
  return (
    <>
      {entries.map((entry) => {
        const expanded = entry.folder && tree.expanded.has(entry.path);
        const active = !entry.folder && entry.path === tree.path;
        const icon = entry.folder ? (expanded ? "open" : "folder") : "file";
        const style = { "--depth": depth } as CSSProperties;
        return (
          <Fragment key={entry.path}>
            {tree.renaming === entry.path ? (
              <div className="tree-row" style={style}>
                <div className="sidebar-item editing">
                  <Icon name={icon} />
                  <RenameField
                    name={entry.name}
                    onDone={(name) => tree.rename(entry, name)}
                  />
                </div>
              </div>
            ) : (
              <div
                className={`tree-row ${active ? "active" : ""} ${entry.path === tree.folder ? "selected" : ""}`}
                style={style}
                onContextMenu={() => {
                  if (!tree.disabled) tree.menu(entry);
                }}
              >
                <button
                  className="sidebar-item"
                  role="treeitem"
                  aria-expanded={entry.folder ? expanded : undefined}
                  aria-current={active || undefined}
                  disabled={tree.disabled}
                  title={entry.name}
                  onClick={() => tree.open(entry)}
                  onDoubleClick={() => tree.startRename(entry)}
                >
                  <Icon name={icon} />
                  <span className="label">{entry.name}</span>
                  {tree.edited.has(entry.path) && (
                    <span className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                </button>
                <button
                  className="icon-button rename"
                  disabled={tree.disabled}
                  onClick={() => tree.startRename(entry)}
                  aria-label={`Rename ${entry.name}`}
                  title="Rename"
                >
                  <Icon name="pencil" />
                </button>
              </div>
            )}
            {expanded && (
              <Tree entries={entry.children} depth={depth + 1} tree={tree} />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// Menus live on the Rust side and are dropped once nothing references them, so the open one is kept here.
let openMenu: Menu | null = null;

function showMenu(
  items: NonNullable<MenuOptions["items"]>,
  onError: (reason: unknown) => void,
) {
  if (!desktop) return;
  void Menu.new({ items })
    .then((menu) => {
      openMenu = menu;
      return menu.popup();
    })
    .catch(onError);
}

function RenameField({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null) => void;
}) {
  const finished = useRef(false);
  const finish = (value: string | null) => {
    if (!finished.current) {
      finished.current = true;
      onDone(value);
    }
  };
  return (
    <input
      className="rename-field"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      aria-label="Name"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
    />
  );
}

function useTheme() {
  const [preference, setPreference] = useState<"light" | "dark" | null>(() => {
    try {
      const saved = localStorage.getItem("excali-theme");
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return null;
    }
  });
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const change = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!preference) return;
    try {
      localStorage.setItem("excali-theme", preference);
    } catch {
      // The toggle still works when preference storage is unavailable.
    }
  }, [preference]);
  return [preference ?? (dark ? "dark" : "light"), setPreference, preference] as const;
}
