// Verify the actual distributable runs outside the repo without Bun on PATH.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun scripts/check-mcp.ts /absolute/path/to/excali-mcp");
const directory = await mkdtemp(join(tmpdir(), "excali-mcp-"));
const client = new Client({ name: "packaged-server-check", version: "1" });
const transport = new StdioClientTransport({
  command: resolve(executable), args: [], cwd: directory,
  env: { ...getDefaultEnvironment(), PATH: process.platform === "win32" ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin" },
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "create_view"));
  assert.ok(tools.some((tool) => tool.name === "create_slides"));
  const guide = CallToolResultSchema.parse(await client.callTool({ name: "read_me", arguments: {} }));
  assert.ok(!guide.isError);
  assert.ok(guide.content.some((item) => item.type === "text" && item.text.includes("Excali Desktop extension")));
  const reference = (await client.readResource({ uri: "excali://reference" })).contents[0];
  assert.ok("text" in reference && reference.text.includes("Excalidraw Element Format"));
  assert.equal((await client.getPrompt({ name: "create-presentation", arguments: { topic: "Release packaging" } })).messages.length, 1);
  console.log(`Packaged MCP server passed: ${tools.length} tools, embedded reference, and presentation prompt; no repository or Bun on PATH.`);
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
