import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Excalidraw's font picker lists its internal font registry, which the package doesn't export.
// Publish the registry class so installed fonts can be added to it.
const registry = /static get registered\(\)\s*\{/;
const excalidraw = /@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/;
const exposeFonts = (code: string) => code.replace(registry, "static{globalThis.__excalidrawFonts=this}$&");

const exposeFontsPlugin: Plugin = {
  name: "expose-excalidraw-fonts",
  transform: (code, id) => excalidraw.test(id) && registry.test(code) ? exposeFonts(code) : null,
};

export default defineConfig({
  plugins: [react(), exposeFontsPlugin],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [{
        name: "expose-excalidraw-fonts",
        setup: (build) => build.onLoad({ filter: excalidraw }, async ({ path }) => ({ contents: exposeFonts(await readFile(path, "utf8")), loader: "js" })),
      }],
    },
  },
  server: { port: 5173, strictPort: true },
  clearScreen: false,
});
