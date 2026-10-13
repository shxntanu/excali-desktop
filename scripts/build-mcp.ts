import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Release builders can select a matching Rust/Bun target for cross-compilation.
const target = process.env.MCP_TARGET ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const bunTargets: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};
if (!target || !bunTargets[target]) throw new Error(`Unsupported MCP executable target: ${target}`);
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(new URL("../src-tauri/binaries/", import.meta.url), { recursive: true });
execFileSync(process.execPath, [
  "build", "scripts/mcp.ts", "--compile", `--target=${bunTargets[target]}`,
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--outfile", `src-tauri/binaries/excali-mcp-${target}${target.includes("windows") ? ".exe" : ""}`,
], { cwd: root, stdio: "inherit" });
