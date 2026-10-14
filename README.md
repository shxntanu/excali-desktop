<p align="center">
  <img src="src-tauri/icons/64x64.png" alt="Excali Desktop" width="64" />
</p>

<h1 align="center">Excali Desktop</h1>

<p align="center">
  <strong>A supercharged Excalidraw for the desktop.</strong>
</p>

<p align="center">
  <img width="1680" height="1050" alt="Excali Desktop" src="assets/excali-desktop.png" />
</p>

Create presentations, slide decks, and work with multiple Excalidraw files at once, with full MCP support so that your agents can work with you. Fully private, fully offline, fully yours.

## Install

Download the macOS app from [GitHub Releases](https://github.com/shxntanu/excali-desktop/releases/latest). You do not need to clone this repository or install Bun, Node.js, Rust, or any other development tools. The editor, fonts, and MCP server are included.

1. Open **Apple menu → About This Mac** to check your processor. Download the `.dmg` under the release's **Assets**: choose `aarch64` for an Apple Silicon Mac (M1, M2, M3, etc.), or `x64` for an Intel Mac. The GitHub-generated **Source code** archives are not installers.
2. Double-click the downloaded `.dmg` to mount it.
3. Drag **Excali Desktop** onto the **Applications** shortcut in the disk image. If prompted, authenticate to copy it into `/Applications`.
4. Eject the disk image in Finder. Open **Excali Desktop** from your Applications folder, rather than running it from inside the disk image.

### First launch of an unsigned app

These releases are **not Developer ID signed or notarized by Apple**, so macOS may say it cannot verify the developer or check the app for malicious software.

1. Try opening the installed app once, then dismiss the blocked-app message without moving the app to the Trash.
2. Open **System Settings → Privacy & Security**. Scroll down to the security section and find the message about Excali Desktop being blocked.
3. Click **Open Anyway**, authenticate if asked, and confirm **Open**. This approval normally only needs to be done once for that installed version. On older macOS versions, the setting is in **System Preferences → Security & Privacy → General**.

If macOS instead reports that the app is “damaged” or there is no **Open Anyway** option, and you downloaded it from this repository's release page, remove the quarantine attribute from this app only:

```sh
xattr -dr com.apple.quarantine "/Applications/Excali Desktop.app"
```

Then open it again from Applications. This removes macOS's downloaded-file restriction for this app; use it only for a download you trust. A managed work Mac may prohibit these exceptions; contact your administrator if the setting is unavailable or blocked.

### Updates and uninstalling

To update, quit Excali Desktop, download the newer DMG, and drag the app into Applications again, choosing **Replace**. There is no automatic updater. macOS may ask you to approve the new version again. Your drawings and recovery data remain in `~/.excali-desktop`, separate from the application. The bundled MCP executable updates along with the app; keep using the same MCP configuration path.

To uninstall, quit the app and move **Excali Desktop.app** from Applications to the Trash. This leaves your drawings intact. Delete `~/.excali-desktop` separately only if you want to remove your drawings and app data too.

### Install from source

For source development, clone the repository and install the dependencies:

```sh
# Install dependencies
bun install --frozen-lockfile
```

Then build and install the app in `~/Applications`:

```sh
bun run desktop:build
mkdir -p ~/Applications
rm -rf ~/Applications/"Excali Desktop.app"ditto src-tauri/target/release/bundle/macos/"Excali Desktop.app" ~/Applications/"Excali Desktop.app"
```

## Run

Install [Bun](https://bun.sh/) 1.4.0+, Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. On macOS, install Xcode Command Line Tools with `xcode-select --install`.

```sh
bun run desktop
```

The installation step copies bundled Excalidraw fonts into `public/fonts`. They are included in the app, so editing does not require a CDN, account, or server. The font picker uses only Excalidraw's bundled fonts; installed system fonts are not scanned or registered at startup. Internet access is required to install dependencies, not to use the built editor.

Bun manages dependencies and runs the JavaScript tooling and tests; Node.js is not required. Vite builds the frontend, and Tauri still uses Rust and the system webview for the desktop app. Faster tooling does not directly change the app's runtime performance. Commit `bun.lock` when changing dependencies.

## Use

Drawings live in `~/.excali-desktop`. The sidebar shows that folder as a tree of folders and drawings; click a drawing to open it.

- **New** always creates a separate blank tab, so you can keep multiple untitled drawings open. Unsaved drawings appear only in the tab bar. **Save** puts a new drawing in the selected folder as "Untitled" (or "Untitled 2", …), adds it to the sidebar, and lets you name it right away.
- The folder button next to **Drawings** creates a folder inside the selected one. Click **Drawings** to target the top level again.
- Double-click a drawing or folder, or use its pencil button, to rename it. Enter confirms; Escape cancels.
- **Open** uses a native file picker for `.excalidraw` files (and Excalidraw JSON) anywhere on disk. Files outside `~/.excali-desktop` stay where they are and are listed under **Other locations** in the sidebar so you can reopen them later; the × button removes one from the list without touching the file. Files saved with **Save as…** outside the drawings folder are listed there too.
- **Save** writes back to the open file.
- **Save as…** saves a copy at a new location and makes it the active document.
- Each open drawing gets a tab above the canvas. Opening a drawing that is already open switches to its tab; a blank, untouched tab is reused instead of left behind. Close a tab with its × button, a middle click, its right-click menu, or Cmd/Ctrl+W (Shift+Cmd/Ctrl+W closes the window).
- A new window reopens the last selected saved drawing. If unsaved tabs are recovered, the previously selected recovery tab takes priority. New tabs animate into view and respect your system’s reduced-motion setting.
- Ctrl+Tab and Ctrl+Shift+Tab move between tabs; Cmd/Ctrl+1–8 jump to a tab and Cmd/Ctrl+9 to the last one.
- Cmd/Ctrl+N (new tab), Cmd/Ctrl+O, Cmd/Ctrl+S, and Cmd/Ctrl+Shift+S are supported. Save and Save as apply to the current tab.
- The application asks you to save, discard, or cancel before closing a modified drawing, including when quitting, once for each modified tab.

### Presentations

Every frame is a slide. Use **New slide** in the slides panel for a preset frame, or draw frames with the frame tool (F), then press **Present** (⇧⌘P / Shift+Ctrl+P) in the sidebar or the play button at the top right of the canvas.

- **Slides** at the top right of the canvas opens the slides panel: drag thumbnails, or use ⌥↑/⌥↓ on a focused one, to reorder them. Click a slide to go to it; double-click to present from it.
- **New slide ▾** offers 16:9, 16:10, 4:3, and custom dimensions, and remembers the last size. **Slide size** changes an existing frame without stretching its contents; **Lock aspect ratio** keeps its proportions when resizing. The freeform frame tool remains available.
- **Slide actions** under each thumbnail offers **New after**, **Duplicate**, **Rename**, and **Delete**. New slides inherit the selected slide's dimensions unless a deck size is configured. Duplicates keep the slide's objects, groups, bindings, reveal steps, transition, and dimensions. These operations support undo.
- The new-slide options offer **Blank**, **Title + content**, **Two columns**, and **Diagram + caption** starters made of ordinary editable objects. Optional safe margins and center guides appear only in the editor. **Align selection to slide** moves selected objects together within those margins, including bound labels.
- **Deck defaults** sets the size, transition/speed, and animation effect for new slides and reveal steps. Each has an explicit **Apply to all** action for existing content. Defaults are saved with slide frames in the drawing; applying a size changes frames without stretching their contents.
- With a slide or anything on it selected, the panel sets how the slide comes in (**Move** flies the camera across the canvas, **Dissolve** crossfades, **Cut** is instant), the speed, and whether to skip it when presenting.
- **Reveal steps** shows reveal steps by object label. Select objects and choose **Reveal together** or **Reveal separately**, or assign them to an existing reveal step. Each row selects its objects, changes its effect, and removes its animation. Drag rows, use their arrow buttons, or press ⌥↑/⌥↓ on a focused row to reorder reveal steps. Bound text follows its container.
- **Preview** plays reveal steps inside the panel without editing the drawing. Previous/next, Restart, and ←/→/Home/End step through the reveals. Optional numbered canvas badges show reveal order and select their objects.
- While presenting: → / Space / Enter or a click goes to the next reveal step or slide, ← / Backspace or a right-click goes back, ⇧→/⇧← skip whole slides, Home/End jump to the ends, a number followed by Enter jumps to that slide, L toggles the laser pointer, B or W blanks the screen, ? lists the shortcuts, and Esc ends the presentation.

Slides are shown fullscreen and letterboxed to each frame's shape. Slide order, transitions, and reveal steps are saved in the drawing (in the elements' `customData`), so they travel with the file; excalidraw.com ignores them. Presenting never modifies the drawing. With reduced motion turned on in the system settings, transitions and reveal steps are instant.

Use Open for drawings and Excalidraw's Insert image tool for images. File drag-and-drop is not supported in this first version. The canvas is temporarily inactive during file operations.

Each tab keeps its own undo history while it is open. Images are embedded in saved files. Saves use a temporary file in the destination folder and replace the destination only after the complete write succeeds.

Everything the app stores lives in `~/.excali-desktop`: your drawings, plus a hidden `.app` folder with the recovery snapshot (`recovery.json`) and the list of files opened from other locations (`linked.json`). A recovery snapshot left by an earlier version in the OS application-data folder is moved there on first launch.

Panning, zooming, and selection do not count as document edits or restart recovery writes. The slides list stays unchanged during viewport movement; canvas guides and reveal badges track the viewport independently.

Unsaved edits are debounced into the recovery snapshot approximately 800 ms after the last edit. A crash can lose edits made since the latest snapshot. The snapshot covers every tab with unsaved edits. At startup, each one is restored as an unsaved document in its own tab; save it to keep it. Recovery is removed after a successful save or an explicit discard. This is crash recovery, not version history.

## Build

```sh
bun run desktop:build
```

On macOS the app is generated at `src-tauri/target/release/bundle/macos/Excali Desktop.app`. The current bundle target is a macOS `.app`; Windows/Linux packaging targets and signing should be configured when those distributions are needed.

### Publish a macOS release on demand

The [Publish macOS release workflow](.github/workflows/release-macos.yml) runs only when manually requested. It builds separate Apple Silicon and Intel DMGs and publishes a GitHub release after both builds and bundled MCP checks succeed. It has no schedule or push/tag trigger, and requires no Apple Developer account or signing secrets. GitHub's built-in `GITHUB_TOKEN` supplies release upload permission.

1. Push this workflow to the repository's default branch so GitHub exposes **Run workflow**. Ensure GitHub Actions is enabled in the repository settings.
2. Set the release version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, keeping them aligned; commit and push the changes you want to release. The workflow checks that the supplied tag matches `v` plus the version in `tauri.conf.json`.
3. Open the repository's **Actions** tab, select **Publish macOS release**, and click **Run workflow**.
4. Select the branch containing the release commit, and enter a new release tag such as `v0.1.0`. Click **Run workflow** to start. You need repository write access to dispatch it.
5. Wait for both build jobs and the publish job to finish. The workflow creates the tag at the selected commit and publishes a release with both `.dmg` files and installation notes under [Releases](https://github.com/shxntanu/excali-desktop/releases).

The release becomes public automatically when the workflow succeeds. Use a new tag for each release; an existing release causes publication to fail rather than replacing its assets. If a build fails, inspect its Actions logs, fix the problem, and run the workflow again. Successful build jobs also retain their DMG as a workflow artifact. No release is published when either build or its MCP check fails.

To generate an unsigned DMG locally for your Mac:

```sh
CI=true bun run tauri build --bundles app,dmg
```

`CI=true` skips Finder automation for arranging the disk image, so packaging does not need permission to control Finder. GitHub Actions sets this automatically. Find the disk image in `src-tauri/target/release/bundle/dmg/`. The workflow explicitly selects each Rust/MCP target, so its build outputs instead live under `src-tauri/target/<target>/release/bundle/`.

## Frontend preview

```sh
bun run dev
```

Open `http://127.0.0.1:5173`. The browser preview imports drawings through a file input and saves through downloads; it cannot overwrite desktop files. Recovery uses local storage in this mode. Use the desktop command for native file persistence.

## Checks

```sh
bun run build
bun test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The small tests cover invalid-document rejection, ordered recovery writes after failures, and replacement of existing files. Native file dialogs and quitting should also be checked interactively on each target OS.

## Boundaries

No document version history, sync, or account system yet. Presentations have no presenter view or speaker notes, and slides can't be exported to PDF. Deleting and moving drawings is done in Finder for now; the sidebar refreshes when the window regains focus. Files modified externally are not watched; saving will replace the current file. The core editor and fonts are local; the production content-security policy blocks remote resources and embedded web pages.

Excalidraw and the other dependencies retain their respective licenses. This wrapper is not an official Excalidraw application.

## Agents and MCP

The desktop app exposes a local MCP server over **stdio**, using the official
[Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp) element format and
reference instructions, extended with desktop documents and presentations.
Keep Excali Desktop open while your agents work. The installed app contains
an MCP executable with its runtime, dependencies, and instructions embedded.
Users do not need Bun, Node.js, or the source repository.

Click the robot **AI** button at the bottom right of the sidebar for setup
instructions and a **Copy drawing prompt** action. Paste the prompt into your
assistant and replace the change placeholder with your request. It targets the
current live tab by document ID, including unsaved edits. Keep that tab open;
copy a fresh prompt after reopening it or restarting the app.

For a macOS app installed in `/Applications`, add this to an agent client's
MCP configuration:

```json
{
  "mcpServers": {
    "excali-desktop": {
      "command": "/Applications/Excali Desktop.app/Contents/MacOS/excali-mcp",
      "args": []
    }
  }
}
```

Use the actual installation path if the app lives somewhere else, such as
`~/Applications`; MCP configuration should contain an absolute path.
The client launches the embedded executable over stdio, and it connects to
the running editor automatically. App updates replace the server together
with the editor.

Source developers can still run `bun run mcp`, or configure Bun as the
command with the absolute path to `scripts/mcp.ts` as its argument. Bun is
needed only for source development and builds. A stdio server waits for an
MCP client rather than accepting interactive commands.

### Publishing builds

`bun run desktop:build` compiles the server into a standalone executable
with Bun and packages it as a Tauri sidecar inside the macOS app. Distribute
`src-tauri/target/release/bundle/macos/Excali Desktop.app`; the repository,
`node_modules`, and Bun installation are not part of the user setup. The
embedded runtime increases the app's size.

Build separate Apple Silicon and Intel releases using the matching build
machine. For a cross-build, install the matching Rust target and set
`MCP_TARGET` to the same target passed to Tauri, for example:

```sh
MCP_TARGET=x86_64-apple-darwin bun run tauri build --target x86_64-apple-darwin
```

The build helper also recognizes common Linux and Windows targets; native
app packaging still needs the corresponding platform configuration and
prerequisites. The manual release workflow distributes unsigned macOS DMGs;
see [Install](#install) for the first-launch approval steps. Apple code signing
and notarization can be added later. Tauri manages the executable as a bundled
sidecar.

Verify a release's embedded server with:

```sh
bun scripts/check-mcp.ts "src-tauri/target/release/bundle/macos/Excali Desktop.app/Contents/MacOS/excali-mcp"
```

This check starts the executable in an empty temporary directory with Bun
absent from `PATH`, then verifies MCP initialization, tools, embedded
instructions, resources, and prompts. It does not modify drawings.

Ask an agent: “Use excali-desktop to draw our architecture, then create a
five-slide presentation explaining it and save the drawing.”

| Tools                                            | Purpose                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `read_me`, `create_view`                         | Official element reference and compact diagram creation              |
| `list_documents`, `get_scene`, `read_checkpoint` | Open tabs, live elements, embedded images, and manual edits          |
| `update_elements`                                | Undoable element edits and deletion                                  |
| `create_slides`, `update_slide`                  | Frame-based slides, order, transitions, visibility, and reveal steps |
| `list_drawings`, `open_drawing`, `save_document` | Workspace discovery, opening, and atomic saves                       |
| `import_drawing`, `add_files`                    | Portable drawing imports and embedded base64 images                  |
| `export_scene`                                   | SVG or PNG of a drawing or an individual slide                       |

The server also exposes `excali://reference` and `excali://active` resources,
and a `create-presentation` prompt. It works with clients that support standard
MCP tools; MCP Apps support is not required.

`create_view` creates a new tab unless its elements begin with
`{"type":"restoreCheckpoint","id":"CHECKPOINT_ID"}`. A returned
`checkpointId` is the same as the live `documentId`, scoped to this app
session. Restoring edits the live tab, including your manual edits; read
`get_scene` first. IDs expire when their tab closes or the app restarts.
The official `delete` and `cameraUpdate` pseudo-elements are supported.
The final camera is applied immediately; the upstream chat widget and
streaming animation are replaced by the desktop editor.

`create_slides` takes slides with a title, optional dimensions (default
1280×720), settings, and compact Excalidraw elements. Element coordinates are
relative to each slide. A title is placed at (64,48); put body content below
y=120. Pass `documentId` to append slides to a drawing. For a reveal step, set an
element's `customData` to `{"build":{"step":1,"effect":"rise"}}`.
`update_slide` can change those reveal steps and the frame's saved slide settings.

Agent changes remain unsaved until `save_document` or your Save command runs.
They participate in crash recovery; edits to an existing tab are undoable.
New saves use a unique name in `~/.excali-desktop`, so a name collision never
overwrites a different drawing. Existing tabs save back to their current
file. Agent opening is limited to drawings listed in the workspace; it never
opens a native file dialog. File operations and presentation mode reject
agent requests while the editor is busy.

The desktop bridge listens only on `127.0.0.1`, uses a new bearer token on
launch, rejects browser-origin requests, and records its connection in
`~/.excali-desktop/.app/mcp.json` (owner-only permissions on Unix). The stdio
server discovers that connection automatically. There is no public upload or
network service dependency. The hosted official MCP server does not connect
to your desktop app; configure this adapter to work on local documents.
