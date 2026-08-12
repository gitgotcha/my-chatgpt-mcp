export type GoogleServiceAccountEnvironment = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
};

type CredentialFailure = { status: number; configuration?: true };

function failure(status: number, configuration = false): CredentialFailure {
  return configuration ? { status, configuration: true } : { status };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonBase64Url(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function privateKeyBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!base64) throw failure(503, true);
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw failure(401);
  }
}

export class GoogleServiceAccountCredential {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly env: GoogleServiceAccountEnvironment,
    private readonly fetchLike: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async token(): Promise<string> {
    const email = this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = this.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (!email || !privateKey) throw failure(503, true);
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token;

    const iat = Math.floor(this.now() / 1000);
    const input = `${jsonBase64Url({ alg: "RS256", typ: "JWT" })}.${jsonBase64Url({
      iss: email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    })}`;
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "pkcs8",
        privateKeyBytes(privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
    } catch {
      throw failure(401);
    }
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
    const assertion = `${input}.${base64Url(new Uint8Array(signature))}`;
    const response = await this.fetchLike("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!response.ok) throw failure(response.status);
    let value: { access_token?: unknown; expires_in?: unknown };
    try {
      value = await response.json() as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw failure(503);
    }
    if (typeof value.access_token !== "string") throw failure(503);
    this.cached = { token: value.access_token, expiresAt: this.now() + (typeof value.expires_in === "number" ? value.expires_in : 300) * 1000 };
    return this.cached.token;
  }
}
