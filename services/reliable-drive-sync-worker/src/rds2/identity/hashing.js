// Shared hashing helper for RDS V2 server modules. Uses the Web Crypto
// subtle API (available in Workers and Node >= 19) so the same code runs on
// both runtimes without a Node-only dependency.
export async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
