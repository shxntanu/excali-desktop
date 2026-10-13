import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";
import { parseElements, slidesSchema, slideSkeletons } from "../src/mcp-schema";
import { getSlides } from "../src/presentation";

test("MCP handshake, discovery, tool validation, errors, resources and prompts", async () => {
  const calls: string[] = [];
  const server = createServer(async (method) => {
    calls.push(method);
    if (method === "open_drawing") throw new Error("Choose a workspace drawing");
    return { documentId: "42", elements: [] };
  });
  const client = new Client({ name: "test-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "create_slides"));
    assert.equal(tools.find((tool) => tool.name === "create_view")?.annotations?.readOnlyHint, false);
    const invalid = await client.callTool({ name: "create_view", arguments: { elements: '[{"type":"iframe","x":0,"y":0}]' } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
    const valid = await client.callTool({ name: "create_view", arguments: { elements: '[{"type":"rectangle","x":0,"y":0,"width":100,"height":100}]' } });
    assert.deepEqual(valid.structuredContent, { documentId: "42", elements: [] });
    const failure = await client.callTool({ name: "open_drawing", arguments: { path: "/outside" } });
    assert.equal(failure.isError, true);
    const badSlides = await client.callTool({ name: "create_slides", arguments: { slides: [{ title: "Broken", settings: { transition: "invalid" } }] } });
    assert.equal(badSlides.isError, true);
    const reference = (await client.readResource({ uri: "excali://reference" })).contents[0];
    assert.ok("text" in reference && reference.text.includes("Excali Desktop extension"));
    const active = (await client.readResource({ uri: "excali://active" })).contents[0];
    assert.ok("text" in active);
    assert.equal(JSON.parse(active.text).documentId, "42");
    assert.equal((await client.getPrompt({ name: "create-presentation", arguments: { topic: "MCP" } })).messages[0].role, "user");
  } finally { await client.close(); await server.close(); }
});

test("official format validates commands and slide generation preserves membership, settings and builds", () => {
  assert.throws(() => parseElements('[{"type":"text","x":0,"y":0}]'));
  assert.throws(() => parseElements('[{"type":"rectangle","id":"same","x":0,"y":0},{"type":"ellipse","id":"same","x":0,"y":0}]'));
  parseElements('[{"type":"cameraUpdate","x":0,"y":0,"width":800,"height":600},{"type":"arrow","x":100,"y":100,"width":-100,"height":0},{"type":"delete","ids":"old"}]');
  const slides = slidesSchema.parse([{ title: "Intro", settings: { transition: "dissolve" }, elements: [{ type: "rectangle", id: "box", x: 64, y: 200, width: 100, height: 100, customData: { build: { step: 1, effect: "rise" } } }] }, { title: "End", elements: [] }]);
  const skeletons = slideSkeletons(slides).map((element) => ({ ...element, width: "width" in element ? element.width ?? 100 : 100, height: "height" in element ? element.height ?? 100 : 100, version: 1, isDeleted: false, frameId: "frameId" in element ? element.frameId : null }));
  const result = getSlides(skeletons);
  assert.equal(result.length, 2);
  assert.equal(result[0].settings.transition, "dissolve");
  assert.deepEqual(result[0].steps, [1]);
  assert.equal(result[0].elements.find((element) => element.id === "box")?.frameId, result[0].frame.id);
  assert.equal(result[1].settings.order, 1);
});
