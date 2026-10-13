# Upstream reference

`element-reference.md` is the `RECALL_CHEAT_SHEET` from the official
[Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp),
`src/server.ts` at commit `157aa23ceb1976008aadc89eb05e3444060f09d6`.
Upstream declares the MIT license in its README. Its element reference is
reused here with desktop-specific behavior documented by `read_me`.

The desktop adapter uses the official `read_me`, `create_view`,
`restoreCheckpoint`, `delete`, and `cameraUpdate` vocabulary. Rendering,
checkpoints, and persistence use the local desktop editor. It does not call
the hosted service or embed the upstream MCP App HTML. Desktop checkpoints
refer to live tabs, so manual edits are always included.
