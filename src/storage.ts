import { invoke, isTauri } from "@tauri-apps/api/core";
import { validateDrawing } from "./document";

export const desktop = isTauri();
const recoveryKey = "excali-desktop-recovery";

export async function openDocument(): Promise<{ path: string; data: string } | null> {
  if (desktop) return invoke("open_document");
  // The browser preview can import drawings; the desktop uses native dialogs.
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.json";
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try { resolve({ path: file.name, data: await file.text() }); }
      catch (error) { reject(error); }
    };
    input.click();
  });
}

export async function saveDocument(path: string | null, data: string): Promise<string | null> {
  validateDrawing(data);
  if (desktop) return invoke("save_document", { path, data });
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = path || "Untitled.excalidraw";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return link.download;
}

export async function readRecovery(): Promise<string | null> {
  return desktop ? invoke("read_recovery") : localStorage.getItem(recoveryKey);
}

export async function writeRecovery(data: string | null): Promise<void> {
  if (desktop) return invoke("write_recovery", { data });
  if (data === null) localStorage.removeItem(recoveryKey);
  else localStorage.setItem(recoveryKey, data);
}
