import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { Excalidraw, FONT_FAMILY, hashElementsVersion, loadFromBlob, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import { createWriteQueue, fileName, isWithin, parentPath, remapPath, validateDrawing } from "./document";
import { cssFamily, fontId, lineHeight, type SystemFont } from "./fonts";
import { createDrawing, createFolder, deleteEntry, desktop, forgetDocument, listFonts, openDocument, readDrawing, readLinked, readRecovery, readWorkspace, renameEntry, saveDocument, writeRecovery, type Entry, type LinkedDocument, type Workspace } from "./storage";

type Choice = "save" | "discard" | "cancel";

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<{ id: number; data: ExcalidrawInitialDataState | null }>({ id: 0, data: null });
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const theme = useSystemTheme();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Where new drawings and folders go; null means the top of the drawings folder.
  const [folder, setFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [linked, setLinked] = useState<LinkedDocument[]>([]);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const currentPath = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const fingerprint = useRef<string | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef(createWriteQueue());
  const resolvePrompt = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const handlers = useRef({
    new: () => {}, open: () => {}, save: (_as?: boolean) => {}, close: () => {},
    openEntry: (_path: string) => {}, forget: (_path: string) => {}, newFolder: (_parent?: string) => {}, rename: (_entry: Entry, _name: string | null) => {},
    remove: (_entry: Entry) => {},
  });
  const mounted = useRef(true);

  function report(reason: unknown) {
    if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
  }

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
  }

  function stopTimer() {
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
  }

  function serialize() {
    if (!api.current) throw new Error("The editor is still loading. Please try again.");
    return serializeAsJSON(api.current.getSceneElements(), api.current.getAppState(), api.current.getFiles(), "local");
  }

  function persistRecovery() {
    stopTimer();
    if (!dirtyRef.current || !api.current) return Promise.resolve();
    const data = JSON.stringify({ name: fileName(currentPath.current), drawing: serialize() });
    return queue.current(() => writeRecovery(data));
  }

  async function clearRecovery() {
    stopTimer();
    await queue.current(() => writeRecovery(null));
  }

  const onChange: NonNullable<ExcalidrawProps["onChange"]> = (elements, appState) => {
    // Selection and panning are not document edits. No scene copies in React state.
    const next = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${appState.gridSize}:${appState.gridStep}:${appState.gridModeEnabled}`;
    if (fingerprint.current === null) { fingerprint.current = next; return; }
    if (next === fingerprint.current) return;
    fingerprint.current = next;
    revision.current += 1;
    if (!dirtyRef.current) markDirty(true);
    stopTimer();
    recoveryTimer.current = setTimeout(() => { void persistRecovery().catch(report); }, 800);
  };

  async function refresh() {
    if (!desktop) return;
    try {
      const [next, others] = await Promise.all([readWorkspace(), readLinked()]);
      if (mounted.current) { setWorkspace(next); setLinked(others); }
    }
    catch (reason) { report(reason); }
  }

  function reveal(target: string, root: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let parent = parentPath(target); parent !== root && isWithin(parent, root); parent = parentPath(parent)) next.add(parent);
      return next;
    });
  }

  async function save(as = false): Promise<boolean> {
    const savedRevision = revision.current;
    const data = serialize();
    const target = !as && !currentPath.current && workspace ? folder ?? workspace.root : null;
    const destination = target ? await createDrawing(target, data) : await saveDocument(as ? null : currentPath.current, data);
    if (!destination) return false;
    currentPath.current = destination;
    setPath(destination);
    setRecovered(false);
    if (workspace) reveal(destination, workspace.root);
    if (target) setRenaming(destination);
    void refresh();
    if (revision.current === savedRevision) {
      markDirty(false);
      // The drawing was saved even if removing recovery fails.
      await clearRecovery().catch(report);
    } else {
      await persistRecovery().catch(report);
    }
    return true;
  }

  async function canLeave(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    const choice = await new Promise<Choice>((resolve) => { resolvePrompt.current = resolve; setPrompt(true); });
    if (choice === "cancel") return false;
    if (choice === "save") {
      if (!await save()) return false;
      // Edits made while the native save dialog was open also need protection.
      if (dirtyRef.current) return canLeave();
    }
    return true;
  }

  async function replaceDocument(data: ExcalidrawInitialDataState | null, destination: string | null) {
    await clearRecovery();
    api.current = null;
    fingerprint.current = null;
    revision.current = 0;
    currentPath.current = destination;
    setPath(destination);
    markDirty(false);
    setRecovered(false);
    setSession((previous) => ({ id: previous.id + 1, data }));
  }

  async function run(action: () => Promise<unknown>) {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (reason) { report(reason); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  handlers.current = {
    new: () => { void run(async () => { if (await canLeave()) await replaceDocument(null, null); }); },
    open: () => { void run(async () => {
      const file = await openDocument();
      if (!file) return;
      validateDrawing(file.data);
      const data = await loadFromBlob(new Blob([file.data], { type: "application/json" }), null, null);
      if (await canLeave()) await replaceDocument(data, file.path);
      await refresh();
    }); },
    save: (as = false) => { void run(() => save(as)); },
    openEntry: (target: string) => { void run(async () => {
      if (target === currentPath.current) return;
      const text = await readDrawing(target);
      validateDrawing(text);
      const data = await loadFromBlob(new Blob([text], { type: "application/json" }), null, null);
      if (!await canLeave()) return;
      await replaceDocument(data, target);
      if (workspace && isWithin(target, workspace.root)) setFolder(parentPath(target));
    }); },
    forget: (target: string) => { void run(async () => {
      await forgetDocument(target);
      await refresh();
    }); },
    newFolder: (parent?: string) => { void run(async () => {
      if (!workspace) return;
      const created = await createFolder(parent ?? folder ?? workspace.root);
      reveal(created, workspace.root);
      await refresh();
      setRenaming(created);
    }); },
    remove: (entry: Entry) => { void run(async () => {
      await deleteEntry(entry.path);
      if (currentPath.current && isWithin(currentPath.current, entry.path)) {
        // Unsaved edits stay on screen as an untitled drawing instead of disappearing with the file.
        if (dirtyRef.current) { currentPath.current = null; setPath(null); await persistRecovery(); }
        else await replaceDocument(null, null);
      }
      setFolder((value) => value && isWithin(value, entry.path) ? null : value);
      setExpanded((previous) => new Set([...previous].filter((value) => !isWithin(value, entry.path))));
      await refresh();
    }); },
    rename: (entry: Entry, name: string | null) => {
      setRenaming(null);
      if (name === null || !name.trim() || name.trim() === entry.name) return;
      void run(async () => {
        const next = await renameEntry(entry.path, name);
        const move = (value: string) => remapPath(value, entry.path, next);
        if (currentPath.current) { currentPath.current = move(currentPath.current); setPath(currentPath.current); }
        setFolder((value) => value && move(value));
        setExpanded((previous) => new Set([...previous].map(move)));
        await refresh();
      });
    },
    close: () => { void run(async () => {
      if (!await canLeave()) return;
      await clearRecovery();
      if (desktop) await invoke("close_app");
    }); },
  };

  function answer(choice: Choice) {
    dialog.current?.close();
    setPrompt(false);
    resolvePrompt.current?.(choice);
    resolvePrompt.current = null;
  }

  useEffect(() => {
    if (prompt) dialog.current?.showModal();
  }, [prompt]);

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
          const recovery = JSON.parse(saved);
          validateDrawing(recovery.drawing);
          const data = await loadFromBlob(new Blob([recovery.drawing], { type: "application/json" }), null, null);
          if (cancelled) return;
          setSession({ id: 1, data });
          markDirty(true);
          setRecovered(true);
        }
      } catch (reason) { report(reason); }
      finally { if (!cancelled) setReady(true); }
    })();
    // Pick up drawings added or moved in Finder while the app was in the background.
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; mounted.current = false; stopTimer(); window.removeEventListener("focus", refresh); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!["n", "o", "s"].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "s") handlers.current.save(event.shiftKey);
      if (key === "o") handlers.current.open();
      if (key === "n") handlers.current.new();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    const visibility = () => { if (document.visibilityState === "hidden") void persistRecovery().catch(report); };
    // The webview's Reload / Inspect Element menu is only useful in text fields (for copy and paste).
    const contextMenu = (event: MouseEvent) => {
      if (desktop && !(event.target as Element).closest?.("input, textarea, [contenteditable]")) event.preventDefault();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("contextmenu", contextMenu);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    let unlisten: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    let disposed = false;
    if (desktop) void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      handlers.current.close();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(report);
    if (desktop) void listen("request-close", () => handlers.current.close())
      .then((stop) => { if (disposed) stop(); else unlistenQuit = stop; }).catch(report);
    return () => {
      disposed = true;
      unlisten?.();
      unlistenQuit?.();
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const title = `${dirty ? "● " : ""}${fileName(path).replace(/\.excalidraw$/, "")} — Excali Desktop`;
    document.title = title;
    if (desktop) void getCurrentWindow().setTitle(title).catch(report);
  }, [path, dirty]);

  const title = fileName(path).replace(/\.excalidraw$/, "");
  const disabled = busy || !ready;
  const parent = path && parentPath(path);
  const location = parent && workspace && parent !== workspace.root && isWithin(parent, workspace.root)
    ? parent.slice(workspace.root.length + 1).split(/[\\/]/).join(" / ") : null;
  const toggle = <button className="icon-button" onClick={() => setSidebar(!sidebar)}
    aria-label={sidebar ? "Hide sidebar" : "Show sidebar"} aria-expanded={sidebar} title={sidebar ? "Hide sidebar" : "Show sidebar"}><Icon name="sidebar" /></button>;
  return <div className={`app ${mac ? "mac" : ""}`} data-theme={theme}>
    {sidebar && <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-header" data-tauri-drag-region>{toggle}</div>
      <nav className="sidebar-nav" aria-label="File">
        <SidebarItem icon="new" label="New" shortcut={`${command}N`} disabled={disabled} onClick={() => handlers.current.new()} />
        <SidebarItem icon="open" label="Open…" shortcut={`${command}O`} disabled={disabled} onClick={() => handlers.current.open()} />
        <SidebarItem icon="save" label="Save" shortcut={`${command}S`} disabled={disabled} onClick={() => handlers.current.save()} />
        <SidebarItem icon="saveAs" label="Save as…" shortcut={`⇧${command}S`} disabled={disabled} onClick={() => handlers.current.save(true)} />
      </nav>
      <div className="sidebar-heading">
        <button className="heading-label" disabled={!workspace} onClick={() => setFolder(null)} title={workspace?.root}>Drawings</button>
        {workspace && <button className="icon-button" disabled={disabled} onClick={() => handlers.current.newFolder()} aria-label="New folder" title="New folder"><Icon name="folderPlus" /></button>}
      </div>
      <div className="tree" role="tree" aria-label="Drawings">
        {(!path || !workspace || (!isWithin(path, workspace.root) && !linked.some((item) => item.path === path))) && <div className="tree-row active" style={{ "--depth": 0 } as CSSProperties}>
          <div className="sidebar-item" title={path || undefined}><Icon name="file" /><span className="label">{title}</span>{dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}</div>
        </div>}
        {workspace && <Tree entries={workspace.entries} depth={0} tree={{
          path, dirty, expanded, folder, renaming, disabled,
          open: (entry) => {
            if (!entry.folder) return handlers.current.openEntry(entry.path);
            setFolder(entry.path);
            setExpanded((previous) => { const next = new Set(previous); if (!next.delete(entry.path)) next.add(entry.path); return next; });
          },
          startRename: (entry) => setRenaming(entry.path),
          rename: (entry, name) => handlers.current.rename(entry, name),
          menu: (entry) => showMenu([
            entry.folder
              ? { text: "New Folder", action: () => handlers.current.newFolder(entry.path) }
              : { text: "Open", enabled: entry.path !== path, action: () => handlers.current.openEntry(entry.path) },
            { text: "Rename", action: () => setRenaming(entry.path) },
            { item: "Separator" },
            { text: "Move to Trash", action: () => handlers.current.remove(entry) },
          ], report),
        }} />}
        {linked.length > 0 && <>
          <h2 className="sidebar-heading">Other locations</h2>
          {linked.map((item) => {
            const active = item.path === path;
            return <div key={item.path} className={`tree-row ${active ? "active" : ""} ${item.missing ? "missing" : ""}`} style={{ "--depth": 0 } as CSSProperties}>
              <button className="sidebar-item" role="treeitem" aria-current={active || undefined} disabled={disabled}
                title={item.missing ? `Not found: ${item.path}` : item.path} onClick={() => handlers.current.openEntry(item.path)}
                onContextMenu={() => { if (!disabled) showMenu([
                  { text: "Open", enabled: !active && !item.missing, action: () => handlers.current.openEntry(item.path) },
                  { item: "Separator" },
                  { text: "Remove from Sidebar", action: () => handlers.current.forget(item.path) },
                ], report); }}>
                <Icon name="file" /><span className="label">{item.name}</span>
                {active && dirty ? <span className="dirty-dot" aria-label="Unsaved changes" /> : <span className="hint">{item.location}</span>}
              </button>
              <button className="icon-button rename" disabled={disabled} onClick={() => handlers.current.forget(item.path)}
                aria-label={`Remove ${item.name} from sidebar`} title="Remove from sidebar"><Icon name="close" /></button>
            </div>;
          })}
        </>}
      </div>
    </aside>}
    <div className="main">
      <header className="titlebar" data-tauri-drag-region>
        {!sidebar && toggle}
        <div className="titlebar-title" data-tauri-drag-region title={path || undefined}>
          {location && <span className="titlebar-folder" data-tauri-drag-region>{location} / </span>}
          {title}{dirty && <span className="titlebar-edited" data-tauri-drag-region> — Edited</span>}
        </div>
      </header>
      <main className="editor" aria-label="Drawing editor" aria-busy={busy}
        ref={(element) => { if (element) element.inert = busy; }}
        onDropCapture={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          setError(`Use Open (${command}O) to open drawings.`);
        }}>
        {ready && <Excalidraw key={session.id} initialData={session.data} excalidrawAPI={(value) => { api.current = value; }} onChange={onChange} theme={theme}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: false }, toggleTheme: false } }}
          renderTopRightUI={() => null}>
          <MainMenu><MainMenu.DefaultItems.Export /><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
        </Excalidraw>}
        {(error || recovered) && <div className={`toast ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
          <span>{error || "Restored your unsaved drawing."}</span>
          <button className="icon-button" onClick={() => error ? setError(null) : setRecovered(false)} aria-label="Dismiss"><Icon name="close" /></button>
        </div>}
      </main>
    </div>
    <dialog ref={dialog} className="unsaved-dialog" onCancel={(event) => { event.preventDefault(); answer("cancel"); }} aria-labelledby="unsaved-title">
      <h2 id="unsaved-title">Save changes to “{title}”?</h2>
      <div className="dialog-actions"><button onClick={() => answer("discard")}>Don’t save</button><span /><button onClick={() => answer("cancel")} autoFocus>Cancel</button><button className="primary" onClick={() => answer("save")}>Save</button></div>
    </dialog>
  </div>;
}

const command = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
const mac = desktop && navigator.platform.includes("Mac");

type FontRegistry = { registered: Map<number, { metadata: object; fontFaces: { fontFace: { family: string } }[] }> };

// Excalidraw maps font ids to CSS through FONT_FAMILY, and its font picker lists the registry
// that vite.config.ts exposes. Local fonts are skipped when Excalidraw loads or embeds font files.
function registerSystemFonts(fonts: SystemFont[]) {
  const registry = (globalThis as { __excalidrawFonts?: FontRegistry }).__excalidrawFonts;
  if (!registry) throw new Error("Installed fonts could not be added to the font picker.");
  const families = FONT_FAMILY as Record<string, number>;
  for (const font of fonts) {
    if (font.family in families) continue;
    const id = fontId(font.family);
    families[cssFamily(font.family)] = id;
    registry.registered.set(id, {
      metadata: { local: true, metrics: { unitsPerEm: font.unitsPerEm, ascender: font.ascender, descender: font.descender, lineHeight: lineHeight(font) } },
      fontFaces: [{ fontFace: { family: font.family } }],
    });
  }
}

function SidebarItem({ icon, label, shortcut, disabled, onClick }: { icon: IconName; label: string; shortcut: string; disabled: boolean; onClick: () => void }) {
  return <button className="sidebar-item" disabled={disabled} onClick={onClick}>
    <Icon name={icon} /><span className="label">{label}</span><kbd>{shortcut}</kbd>
  </button>;
}

type TreeContext = {
  path: string | null; dirty: boolean; expanded: Set<string>; folder: string | null; renaming: string | null; disabled: boolean;
  open: (entry: Entry) => void; startRename: (entry: Entry) => void; rename: (entry: Entry, name: string | null) => void;
  menu: (entry: Entry) => void;
};

function Tree({ entries, depth, tree }: { entries: Entry[]; depth: number; tree: TreeContext }) {
  return <>{entries.map((entry) => {
    const expanded = entry.folder && tree.expanded.has(entry.path);
    const active = !entry.folder && entry.path === tree.path;
    const icon = entry.folder ? expanded ? "open" : "folder" : "file";
    const style = { "--depth": depth } as CSSProperties;
    return <Fragment key={entry.path}>
      {tree.renaming === entry.path
        ? <div className="tree-row" style={style}><div className="sidebar-item editing"><Icon name={icon} /><RenameField name={entry.name} onDone={(name) => tree.rename(entry, name)} /></div></div>
        : <div className={`tree-row ${active ? "active" : ""} ${entry.path === tree.folder ? "selected" : ""}`} style={style}
          onContextMenu={() => { if (!tree.disabled) tree.menu(entry); }}>
          <button className="sidebar-item" role="treeitem" aria-expanded={entry.folder ? expanded : undefined} aria-current={active || undefined}
            disabled={tree.disabled} title={entry.name} onClick={() => tree.open(entry)} onDoubleClick={() => tree.startRename(entry)}>
            <Icon name={icon} /><span className="label">{entry.name}</span>{active && tree.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
          </button>
          <button className="icon-button rename" disabled={tree.disabled} onClick={() => tree.startRename(entry)} aria-label={`Rename ${entry.name}`} title="Rename"><Icon name="pencil" /></button>
        </div>}
      {expanded && <Tree entries={entry.children} depth={depth + 1} tree={tree} />}
    </Fragment>;
  })}</>;
}

// Menus live on the Rust side and are dropped once nothing references them, so the open one is kept here.
let openMenu: Menu | null = null;

function showMenu(items: NonNullable<MenuOptions["items"]>, onError: (reason: unknown) => void) {
  if (!desktop) return;
  void Menu.new({ items }).then((menu) => { openMenu = menu; return menu.popup(); }).catch(onError);
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const finished = useRef(false);
  const finish = (value: string | null) => { if (!finished.current) { finished.current = true; onDone(value); } };
  return <input className="rename-field" defaultValue={name} autoFocus spellCheck={false} aria-label="Name"
    onFocus={(event) => event.currentTarget.select()}
    onBlur={(event) => finish(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") finish(event.currentTarget.value);
      if (event.key === "Escape") finish(null);
    }} />;
}

type IconName = "new" | "open" | "save" | "saveAs" | "file" | "sidebar" | "close" | "folder" | "folderPlus" | "pencil";

function Icon({ name }: { name: IconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {(name === "new" || name === "file" || name === "saveAs") && <path d="M14 3v4a1 1 0 0 0 1 1h4" />}
    {(name === "new" || name === "file") && <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />}
    {name === "new" && <path d="M12 11v6M9 14h6" />}
    {name === "saveAs" && <path d="M11.5 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v5m-5 6h7m-3-3 3 3-3 3" />}
    {name === "open" && <path d="m5 19 2.757-7.351a1 1 0 0 1 .936-.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211A2 2 0 0 1 19.026 19H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" />}
    {name === "save" && <><path d="M6 4h10l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" /><circle cx="12" cy="14" r="2" /><path d="M14 4v4H8V4" /></>}
    {name === "sidebar" && <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16" /></>}
    {name === "close" && <path d="M18 6 6 18M6 6l12 12" />}    {(name === "folder" || name === "folderPlus") && <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />}
    {name === "folderPlus" && <path d="M12 10v6M9 13h6" />}
    {name === "pencil" && <path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4M13.5 6.5l4 4" />}
  </svg>;
}

function useSystemTheme() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const change = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return dark ? "dark" : "light";
}
