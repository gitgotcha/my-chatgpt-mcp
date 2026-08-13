const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const component = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const contentTypes = new Set([
  "application/json",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const fileNames = new Set(["session.json", "raw_transcript.md", "review.json", "profile_update_event.json", "review_report.docx", "resume_parsed.json"]);
const artifactTypes = new Set(["session", "raw_transcript", "review", "profile_update", "report", "resume_parsed"]);

export type ArtifactSubmission = {
  schemaVersion: "1";
  artifactId: string;
  artifactKey: string;
  candidateId: string;
  sourceSkill: "interview";
  sessionId: string;
  artifactType: "session" | "raw_transcript" | "review" | "profile_update" | "report" | "resume_parsed";
  fileName: "session.json" | "raw_transcript.md" | "review.json" | "profile_update_event.json" | "review_report.docx" | "resume_parsed.json";
  contentType: "application/json" | "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  contentBase64: string;
  sha256: string;
  createdAt: string;
  dependsOn?: string[];
  bytes: Uint8Array;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Artifact submission must be an object");
  return value as Record<string, unknown>;
}
function required(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string" || value[field].trim() === "") throw new TypeError(`Artifact ${field} must be a non-empty string`);
  return value[field] as string;
}
function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new TypeError("Artifact contentBase64 is invalid");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > MAX_ARTIFACT_BYTES) throw new TypeError("Artifact size exceeds 10 MiB");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new TypeError("Artifact size exceeds 10 MiB");
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return [...digest].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function parseArtifactSubmission(input: unknown): Promise<ArtifactSubmission> {
  const value = record(input);
  const schemaVersion = required(value, "schemaVersion");
  const artifactId = required(value, "artifactId");
  const artifactKey = required(value, "artifactKey");
  const candidateId = required(value, "candidateId");
  const sourceSkill = required(value, "sourceSkill");
  const sessionId = required(value, "sessionId");
  const artifactType = required(value, "artifactType");
  const fileName = required(value, "fileName");
  const contentType = required(value, "contentType");
  const contentBase64 = required(value, "contentBase64");
  const sha256 = required(value, "sha256").toLowerCase();
  const createdAt = required(value, "createdAt");
  if (schemaVersion !== "1" || sourceSkill !== "interview" || !component.test(candidateId) || !component.test(sessionId)) throw new TypeError("Artifact identity is invalid");
  if (!artifactKey.startsWith(`${candidateId}:interview:${sessionId}:`) || !artifactTypes.has(artifactType) || !fileNames.has(fileName) || !contentTypes.has(contentType) || !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError("Artifact metadata is invalid");
  const bytes = decodeBase64(contentBase64);
  if (await sha256Hex(bytes) !== sha256) throw new TypeError("Artifact checksum mismatch");
  const dependsOn = value.dependsOn === undefined ? undefined : Array.isArray(value.dependsOn) && value.dependsOn.every((item) => typeof item === "string" && item.length > 0) ? value.dependsOn as string[] : (() => { throw new TypeError("Artifact dependsOn is invalid"); })();
  return { schemaVersion: "1", artifactId, artifactKey, candidateId, sourceSkill: "interview", sessionId, artifactType: artifactType as ArtifactSubmission["artifactType"], fileName: fileName as ArtifactSubmission["fileName"], contentType: contentType as ArtifactSubmission["contentType"], contentBase64, sha256, createdAt, dependsOn, bytes };
}

export function artifactObjectKey(artifact: ArtifactSubmission): string {
  return `interview/${artifact.candidateId}/${artifact.sessionId}/${artifact.sha256}-${artifact.fileName}`;
}
