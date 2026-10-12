import { useEffect, useRef, useState } from "react";
import { Excalidraw, hashElementsVersion, loadFromBlob, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createWriteQueue, fileName, validateDrawing } from "./document";
import { desktop, openDocument, readRecovery, saveDocument, writeRecovery } from "./storage";

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
  const handlers = useRef({ new: () => {}, open: () => {}, save: (_as?: boolean) => {}, close: () => {} });
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

  async function save(as = false): Promise<boolean> {
    const savedRevision = revision.current;
    const destination = await saveDocument(as ? null : currentPath.current, serialize());
    if (!destination) return false;
    currentPath.current = destination;
    setPath(destination);
    setRecovered(false);
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
    }); },
    save: (as = false) => { void run(() => save(as)); },
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
      try {
        const saved = await readRecovery();
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
    return () => { cancelled = true; mounted.current = false; stopTimer(); };
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
    window.addEventListener("keydown", keydown, true);
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
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const title = `${dirty ? "● " : ""}${fileName(path).replace(/\.excalidraw$/, "")} — Excali Desktop`;
    document.title = title;
    if (desktop) void getCurrentWindow().setTitle(title).catch(report);
  }, [path, dirty]);

  const command = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
  return <div className="app-shell">
    <header className="app-header">
      <button className="brand" onClick={() => setSidebar(!sidebar)} aria-label={sidebar ? "Hide document panel" : "Show document panel"} aria-expanded={sidebar} title="Toggle document panel">
        <span className="brand-mark" aria-hidden="true">e<span>.</span></span><span>excali<span className="brand-subtitle">desktop</span></span>
      </button>
      <div className="document-title" title={path || "Unsaved drawing"}>{fileName(path).replace(/\.excalidraw$/, "")}<span className={`status-dot ${dirty ? "unsaved" : ""}`} aria-hidden="true" /></div>
      <nav className="file-actions" aria-label="File actions">
        <button disabled={busy || !ready} onClick={() => handlers.current.new()} title={`New drawing (${command}N)`}>New</button>
        <button disabled={busy || !ready} onClick={() => handlers.current.open()} title={`Open drawing (${command}O)`}><Icon name="folder" />Open</button>
        <button disabled={busy || !ready} onClick={() => handlers.current.save(true)} title={`Save As (${command}⇧S)`}>Save as…</button>
        <button className="primary" disabled={busy || !ready} onClick={() => handlers.current.save()} title={`Save drawing (${command}S)`}><Icon name="save" />{busy ? "Working…" : "Save"}</button>
      </nav>
    </header>
    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    {recovered && <div className="notice" role="status"><span>Recovered your last unsaved drawing. Save it to keep a file on your computer.</span><button onClick={() => setRecovered(false)} aria-label="Dismiss recovery message">×</button></div>}
    <div className="workspace">
      {sidebar && <aside className="document-panel" aria-label="Document panel">
        <div className="panel-section">
          <h2>WORKSPACE</h2>
          <div className="active-document"><Icon name="file" /><div><strong>{fileName(path).replace(/\.excalidraw$/, "")}</strong><span>{dirty ? "Unsaved changes" : path ? "Saved to your computer" : "New drawing"}</span></div></div>
        </div>
        <div className="panel-section document-location"><h2>FILE LOCATION</h2><p>{path || "Save your drawing to choose a location on your computer."}</p></div>
        <div className="panel-section"><h2>YOUR CANVAS, YOUR FILES</h2><p>Draw freely. Open a drawing to pick up where you left off.</p><p className="small-copy">Saved as .excalidraw, ready to open in Excalidraw anywhere.</p></div>
        <div className="panel-bottom">
          <h2>QUICK KEYS</h2>
          <dl><div><dt>New drawing</dt><dd><kbd>{command}N</kbd></dd></div><div><dt>Open drawing</dt><dd><kbd>{command}O</kbd></dd></div><div><dt>Save</dt><dd><kbd>{command}S</kbd></dd></div></dl>
          <div className="offline-label"><span aria-hidden="true" />Works offline</div>
        </div>
      </aside>}
      <main className="editor" aria-label="Drawing editor" aria-busy={busy}
        ref={(element) => { if (element) element.inert = busy; }}
        onDropCapture={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          setError("Use Open to open a drawing, or the Insert image tool to add an image.");
        }}>
        {ready ? <Excalidraw key={session.id} initialData={session.data} excalidrawAPI={(value) => { api.current = value; }} onChange={onChange}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: false }, toggleTheme: false } }}
          renderTopRightUI={() => null}>
          <MainMenu><MainMenu.DefaultItems.Export /><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
        </Excalidraw> : <div className="loading-canvas" role="status">Opening your workspace…</div>}
      </main>
    </div>
    <footer className="status-bar"><span><span className={`status-dot ${dirty ? "unsaved" : ""}`} />{dirty ? "Unsaved changes · recovery enabled" : path ? "All changes saved" : "Ready to draw"}</span><span>{desktop ? "Local files" : "Browser preview · Save downloads a file"}<span className="footer-divider">/</span>Excalidraw 0.18.1</span></footer>
    <dialog ref={dialog} className="unsaved-dialog" onCancel={(event) => { event.preventDefault(); answer("cancel"); }} aria-labelledby="unsaved-title" aria-describedby="unsaved-description">
      <h2 id="unsaved-title">Save your changes?</h2><p id="unsaved-description">Your drawing has unsaved changes. Save them before continuing.</p>
      <div className="dialog-actions"><button onClick={() => answer("cancel")} autoFocus>Cancel</button><button onClick={() => answer("discard")}>Discard changes</button><button className="primary" onClick={() => answer("save")}>Save drawing</button></div>
    </dialog>
  </div>;
}

function Icon({ name }: { name: "folder" | "save" | "file" }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "folder" && <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />}
    {name === "save" && <><path d="M5 3h12l4 4v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></>}
    {name === "file" && <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>}
  </svg>;
}
