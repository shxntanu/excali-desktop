import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildSchema, settingsSchema, slidesSchema, parseElements, filesSchema } from "../src/mcp-schema";

import reference from "../vendor/excalidraw-mcp/element-reference.md" with { type: "text" };
const guide = `${reference}\n\n# Excali Desktop extension\nThis server renders in the desktop app, without an embedded chat widget or streaming animation. create_view without restoreCheckpoint creates a NEW tab. checkpointId is a live documentId for this app session, preserving manual edits. Use get_scene before editing. cameraUpdate applies the final camera immediately. create_slides creates a presentation: each slide becomes a frame; element coordinates are relative to that frame. Titles are placed at (64,48). Put content below y=120. Element customData.build={step:1,effect:"fade"} adds reveals. update_slide sets order, hidden, transition (move/dissolve/cut), duration (0–5000ms), and reveal steps. save_document saves in the desktop workspace; get_scene returns portable Excalidraw JSON. export_scene returns SVG or PNG, optionally one slide. No public upload occurs. IDs last only for the running desktop session.\n`;

export async function rpc(method: string, params: unknown = {}) {
  let descriptor: { url: string; token: string };
  try { descriptor = JSON.parse(await readFile(join(homedir(), ".excali-desktop", ".app", "mcp.json"), "utf8")); }
  catch { throw new Error("Open Excali Desktop before using its MCP tools."); }
  const url = new URL(descriptor.url);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !descriptor.token) throw new Error("Invalid desktop MCP connection file");
  const response = await fetch(new URL("/rpc", url), {
    method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), method, params }), signal: AbortSignal.timeout(25000),
  }).catch(() => { throw new Error("Cannot reach Excali Desktop. Open the app and retry."); });
  if (!response.ok) throw new Error(`Desktop bridge returned HTTP ${response.status}`);
  const result = await response.json() as any;
  if (result.error) throw new Error(result.error);
  return result;
}

export function createServer(call: typeof rpc = rpc) {
  const server = new McpServer({ name: "excali-desktop", version: "0.1.0" });
  const documentId = z.string().optional().describe("Live documentId; omit to use the active tab");
  const register = (name: string, description: string, inputSchema: Record<string, z.ZodType>, readOnly: boolean, method = name) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async (params): Promise<CallToolResult> => {
      try {
        if (name === "create_view") parseElements(params.elements as string);
        const result = await call(method, params);
        if (name === "export_scene" && result.mimeType === "image/png") return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  server.registerTool("read_me", { description: "Official Excalidraw element reference and desktop slide extensions. Read before creating diagrams or slides.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: guide }] }));
  register("create_view", "Create a diagram in a new desktop tab using the official Excalidraw MCP format. Use restoreCheckpoint with a previous checkpointId to edit that live tab.", { elements: z.string().max(5 * 1024 * 1024) }, false);
  register("add_files", "Add embedded base64 images to a drawing. Use each file id as the fileId of an image element in create_view or create_slides.", { documentId, files: filesSchema }, false);
  register("import_drawing", "Import portable .excalidraw JSON into a new unsaved tab, including embedded images and slide metadata.", { json: z.string().max(12 * 1024 * 1024) }, false);
  register("list_documents", "List open tabs, their live documentIds, paths, and unsaved status.", {}, true);
  register("get_scene", "Read current elements, files, slide metadata, and portable Excalidraw JSON. Includes manual user edits.", { documentId }, true);
  register("read_checkpoint", "Read a live desktop checkpoint, including manual edits.", { id: z.string() }, true);
  register("list_drawings", "List drawings and folders in the desktop workspace.", {}, true);
  register("open_drawing", "Open an existing drawing from the desktop workspace.", { path: z.string() }, false);
  register("save_document", "Save a tab. New tabs get a unique workspace filename; existing tabs save to their current path. name is used only for new drawings.", { documentId, name: z.string().min(1).max(200).default("Agent drawing") }, false);
  register("create_slides", "Create a new presentation, or append slides to documentId. Frames are slides. Element x/y coordinates are relative to each slide. Set customData.build for reveals.", { documentId: z.string().optional(), slides: slidesSchema }, false);
  register("update_elements", "Patch existing elements by id (including text, position, styling, customData); optionally delete ids. Preserves other elements and user edits; undoable.", { documentId, updates: z.array(z.looseObject({ id: z.string() })).max(10000).default([]), deleteIds: z.array(z.string()).max(10000).default([]) }, false);
  register("update_slide", "Set a slide's order, visibility, transition, duration, and member reveal steps. A null build value removes its reveal step.", { documentId, frameId: z.string(), settings: settingsSchema.default({}), builds: z.array(z.object({ elementId: z.string(), build: buildSchema.nullable() })).default([]) }, false);
  register("export_scene", "Export the whole drawing or a single frame as SVG text or PNG image.", { documentId, frameId: z.string().optional(), format: z.enum(["svg", "png"]).default("svg") }, true);
  server.registerResource("element-reference", "excali://reference", { mimeType: "text/markdown", description: "Official element format and desktop slide instructions" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] }));
  server.registerResource("active-drawing", "excali://active", { mimeType: "application/json", description: "Active desktop drawing, including unsaved edits" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await call("get_scene")) }] }));
  server.registerPrompt("create-presentation", { description: "Create an editable Excalidraw slide deck", argsSchema: { topic: z.string(), slides: z.string().optional() } }, ({ topic, slides }) => ({ messages: [{ role: "user", content: { type: "text", text: `Read read_me, then create an editable presentation about ${topic}, with ${slides ?? "5"} slides. Use clear titles, diagrams, consistent colors, and selective reveal steps. Save it with save_document.` } }] }));
  return server;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) await createServer().connect(new StdioServerTransport());
