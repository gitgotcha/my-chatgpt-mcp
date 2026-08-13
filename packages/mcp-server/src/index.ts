import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createFetchArtifactTransport, createInterviewApi, ingressTransportFromEnvironment } from "./fetch-ingress.js";
import { LocalOutbox } from "./outbox.js";
import { SubmitEventService } from "./submit-event.js";
import { LocalArtifactOutbox } from "./artifact-outbox.js";
import { ArtifactSubmitService } from "./artifact-service.js";

const syncEventSchema = {
  schemaVersion: z.string().min(1), eventId: z.string().min(1), eventKey: z.string().min(1),
  type: z.string().min(1), userId: z.string().min(1), sourceSkill: z.string().min(1),
  destination: z.literal("drive"), createdAt: z.string().min(1), payload: z.record(z.unknown())
};
const artifactSchema = {
  schemaVersion: z.literal("1"), artifactId: z.string().min(1), artifactKey: z.string().min(1), candidateId: z.string().min(1), sourceSkill: z.literal("interview"), sessionId: z.string().min(1),
  artifactType: z.enum(["session", "raw_transcript", "review", "profile_update", "report", "resume_parsed"]), fileName: z.enum(["session.json", "raw_transcript.md", "review.json", "profile_update_event.json", "review_report.docx", "resume_parsed.json"]),
  contentType: z.enum(["application/json", "text/markdown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]), contentBase64: z.string().min(1), sha256: z.string().length(64), createdAt: z.string().min(1), dependsOn: z.array(z.string().min(1)).optional()
};

async function main(): Promise<void> {
  const outbox = new LocalOutbox(process.env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH ?? "reliable-drive-sync.sqlite");
  const service = new SubmitEventService(outbox, ingressTransportFromEnvironment());
  const artifactOutbox = new LocalArtifactOutbox(process.env.RELIABLE_DRIVE_SYNC_OUTBOX_PATH ?? "reliable-drive-sync.sqlite");
  const config = { url: process.env.RELIABLE_DRIVE_SYNC_INGRESS_URL, sharedSecret: process.env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET };
  const artifactService = new ArtifactSubmitService(artifactOutbox, createFetchArtifactTransport(config) ?? { send: async () => { throw new Error("Ingress is not configured"); } });
  const interviewApi = createInterviewApi(config);
  if (process.argv[2] === "flush-pending") {
    await service.flushPending();
    await artifactService.flushPending();
    return;
  }
  const server = new McpServer({ name: "reliable-drive-sync", version: "0.1.0" });
  server.registerTool("submit_event", {
    description: "Persist an event locally and attempt cloud ingestion; this does not confirm Drive completion.",
    inputSchema: syncEventSchema
  }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await service.submit(input)) }] }));
  server.registerTool("submit_artifact", { description: "Persist an immutable interview artifact locally and attempt cloud ingestion; this does not confirm Drive completion.", inputSchema: artifactSchema }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await artifactService.submit(input)) }] }));
  server.registerTool("list_candidates", { description: "List only safe interview candidate summaries.", inputSchema: { query: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() } }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await requireInterviewApi(interviewApi).listCandidates(input.query, input.limit)) }] }));
  server.registerTool("get_candidate_context", { description: "Read an already confirmed interview candidate context through the cloud service.", inputSchema: { candidateId: z.string().min(1), selectedDomain: z.string().min(1).optional(), resumeId: z.string().min(1).optional(), sessionId: z.string().min(1).optional() } }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await requireInterviewApi(interviewApi).getCandidateContext(input.candidateId, input.selectedDomain, input.resumeId, input.sessionId)) }] }));
  server.registerTool("read_artifact", { description: "Read a confirmed candidate JSON or Markdown interview artifact through the cloud service.", inputSchema: { candidateId: z.string().min(1), artifactKey: z.string().min(1) } }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await requireInterviewApi(interviewApi).readArtifact(input.candidateId, input.artifactKey)) }] }));
  await server.connect(new StdioServerTransport());
}

function requireInterviewApi(api: ReturnType<typeof createInterviewApi>) {
  if (!api) throw new Error("Ingress is not configured");
  return api;
}

void main();
