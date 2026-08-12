import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ingressTransportFromEnvironment } from "./fetch-ingress.js";
import { LocalOutbox } from "./outbox.js";
import { SubmitEventService } from "./submit-event.js";

const syncEventSchema = {
  schemaVersion: z.string().min(1), eventId: z.string().min(1), eventKey: z.string().min(1),
  type: z.string().min(1), userId: z.string().min(1), sourceSkill: z.string().min(1),
  destination: z.literal("drive"), createdAt: z.string().min(1), payload: z.record(z.unknown())
};

async function main(): Promise<void> {
  const outbox = new LocalOutbox(process.env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH ?? "reliable-drive-sync.sqlite");
  const service = new SubmitEventService(outbox, ingressTransportFromEnvironment());
  if (process.argv[2] === "flush-pending") {
    await service.flushPending();
    return;
  }
  const server = new McpServer({ name: "reliable-drive-sync", version: "0.1.0" });
  server.registerTool("submit_event", {
    description: "Persist an event locally and attempt cloud ingestion; this does not confirm Drive completion.",
    inputSchema: syncEventSchema
  }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await service.submit(input)) }] }));
  await server.connect(new StdioServerTransport());
}

void main();
