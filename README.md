# Excali Desktop

A local, offline Excalidraw editor built with Tauri 2, React, TypeScript, and Vite. Excalidraw is pinned to **0.18.1**; the npm and Cargo lockfiles are committed.

## Run

Install Node.js 22.6+ (Node 22 LTS recommended), Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. On macOS, install Xcode Command Line Tools with `xcode-select --install`.

```sh
npm ci
npm run desktop
```

The installation step copies bundled Excalidraw fonts into `public/fonts`. They are included in the app, so editing does not require a CDN, account, or server. Internet access is required to install dependencies, not to use the built editor.

## Use

- **New** creates a blank drawing.
- **Open** uses a native file picker for `.excalidraw` files (and Excalidraw JSON).
- **Save** writes back to the open file, or asks for a destination for a new drawing.
- **Save as…** saves a copy at a new location and makes it the active document.
- Cmd/Ctrl+N, Cmd/Ctrl+O, Cmd/Ctrl+S, and Cmd/Ctrl+Shift+S are supported.
- The application asks you to save, discard, or cancel before replacing or closing a modified drawing, including when quitting.

Use Open for drawings and Excalidraw's Insert image tool for images. File drag-and-drop is not supported in this first version. The canvas is temporarily inactive during file operations.

Only one drawing is open at a time. Opening another drawing resets undo history. Images are embedded in saved files. Saves use a temporary file in the destination folder and replace the destination only after the complete write succeeds.

Unsaved edits are debounced into a recovery snapshot in the OS application-data directory, approximately 800 ms after the last edit. A crash can lose edits made since the latest snapshot. At startup, the last recovery snapshot is restored as an unsaved document; save it to a location you choose. Recovery is removed after a successful save or an explicit discard. This is crash recovery, not version history.

## Build

```sh
npm run desktop:build
```

On macOS the app is generated at `src-tauri/target/release/bundle/macos/Excali Desktop.app`. The current bundle target is a macOS `.app`; Windows/Linux packaging targets and signing should be configured when those distributions are needed.

## Frontend preview

```sh
npm run dev
```

Open `http://127.0.0.1:5173`. The browser preview imports drawings through a file input and saves through downloads; it cannot overwrite desktop files. Recovery uses local storage in this mode. Use the desktop command for native file persistence.

## Checks

```sh
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The small tests cover invalid-document rejection, ordered recovery writes after failures, and replacement of existing files. Native file dialogs and quitting should also be checked interactively on each target OS.

## Boundaries

No presentation tools, document version history, sync, or account system yet. Files modified externally are not watched; saving will replace the current file. The core editor and fonts are local; the production content-security policy blocks remote resources and embedded web pages.

Excalidraw and the other dependencies retain their respective licenses. This wrapper is not an official Excalidraw application.
