export function validateDrawing(text: string): void {
  const value = JSON.parse(text);
  if (!value || value.type !== "excalidraw" || !Array.isArray(value.elements)) {
    throw new Error("Choose a valid .excalidraw drawing. The current drawing has not changed.");
  }
}

export function fileName(path: string | null): string {
  return path?.split(/[\\/]/).pop() || "Untitled.excalidraw";
}

export function parentPath(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);
}

// Follows a renamed file or folder to its new location.
export function remapPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

export type RecoveredDrawing = { name: string; drawing: string };

// Earlier versions saved a single { name, drawing } snapshot instead of a list.
export function parseRecovery(text: string): RecoveredDrawing[] {
  const value = JSON.parse(text);
  const drawings: RecoveredDrawing[] = Array.isArray(value?.documents) ? value.documents : [value];
  for (const item of drawings) validateDrawing(item.drawing);
  return drawings;
}

export function serializeRecovery(drawings: RecoveredDrawing[]): string | null {
  return drawings.length ? JSON.stringify({ documents: drawings }) : null;
}

// Keep queued recovery operations ordered, even after a failed write.
export function createWriteQueue() {
  let tail = Promise.resolve();
  return (write: () => Promise<void>) => {
    const next = tail.then(write);
    tail = next.catch(() => {});
    return next;
  };
}
