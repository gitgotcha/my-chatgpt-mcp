import { describe, expect, it, vi } from "vitest";
import { GoogleServiceAccountCredential } from "../src/service-account.js";

async function testPrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

function decodeJwtPayload(assertion: string): Record<string, unknown> {
  const payload = assertion.split(".")[1]!;
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as Record<string, unknown>;
}

describe("GoogleServiceAccountCredential", () => {
  it("signs a Google JWT bearer assertion and caches its access token", async () => {
    const key = await testPrivateKeyPem();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "service-token", expires_in: 3600 })));
    const credential = new GoogleServiceAccountCredential(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key },
      fetchMock as typeof fetch,
      () => 1_700_000_000_000,
    );

    expect(await credential.token()).toBe("service-token");
    expect(await credential.token()).toBe("service-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(decodeJwtPayload(body.get("assertion")!)).toMatchObject({
      iss: "sync@test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it("accepts Cloudflare-style literal newlines in the private key", async () => {
    const key = (await testPrivateKeyPem()).replace(/\n/g, "\\n");
    const credential = new GoogleServiceAccountCredential(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key },
      (async () => new Response(JSON.stringify({ access_token: "service-token", expires_in: 3600 }))) as typeof fetch,
    );

    await expect(credential.token()).resolves.toBe("service-token");
  });

  it("rejects incomplete service-account configuration without making a token request", async () => {
    const fetchMock = vi.fn();
    const credential = new GoogleServiceAccountCredential(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com" },
      fetchMock as typeof fetch,
    );

    await expect(credential.token()).rejects.toMatchObject({ status: 503, configuration: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([429, 503, 401])("preserves token endpoint status %i without revealing credentials", async (status) => {
    const credential = new GoogleServiceAccountCredential(
      { GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: await testPrivateKeyPem() },
      (async () => new Response("", { status })) as typeof fetch,
    );

    await expect(credential.token()).rejects.toMatchObject({ status });
  });
});
