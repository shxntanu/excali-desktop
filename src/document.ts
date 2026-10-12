export function validateDrawing(text: string): void {
  const value = JSON.parse(text);
  if (!value || value.type !== "excalidraw" || !Array.isArray(value.elements)) {
    throw new Error("Choose a valid .excalidraw drawing. The current drawing has not changed.");
  }
}

export function fileName(path: string | null): string {
  return path?.split(/[\\/]/).pop() || "Untitled.excalidraw";
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
