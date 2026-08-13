import type { IngressResponse, IngressTransport } from "./submit-event.js";
import type { ArtifactIngressResponse, ArtifactIngressTransport, CandidateApi } from "./artifact-service.js";

export type FetchIngressConfig = {
  url?: string;
  sharedSecret?: string;
};

export function createFetchIngressTransport(
  config: FetchIngressConfig,
  fetchImpl: typeof fetch = fetch
): IngressTransport | null {
  const url = config.url?.trim();
  const sharedSecret = config.sharedSecret?.trim();
  if (!url || !sharedSecret || !isHttpUrl(url)) return null;

  return {
    async send(event, signal): Promise<IngressResponse> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sharedSecret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(event),
        signal
      });
      return { status: response.status, body: await responseBody(response) };
    }
  };
}

export function ingressTransportFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): IngressTransport {
  return createFetchIngressTransport({
    url: env.RELIABLE_DRIVE_SYNC_INGRESS_URL,
    sharedSecret: env.RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET
  }, fetchImpl) ?? unavailableIngress();
}

export function createFetchArtifactTransport(config: FetchIngressConfig, fetchImpl: typeof fetch = fetch): ArtifactIngressTransport | null {
  const url = baseUrl(config); if (!url) return null;
  return { async send(artifact, signal): Promise<ArtifactIngressResponse> {
    const response = await fetchImpl(`${url}/v1/artifacts`, { method: "POST", headers: bearer(config.sharedSecret!), body: JSON.stringify({ ...artifact, bytes: undefined }), signal });
    return { status: response.status, body: await responseBody(response) };
  } };
}

export function createInterviewApi(config: FetchIngressConfig, fetchImpl: typeof fetch = fetch): CandidateApi | null {
  const url = baseUrl(config); if (!url) return null;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(`${url}${path}`, { headers: bearer(config.sharedSecret!) });
    if (!response.ok) throw new Error(`Interview API returned ${response.status}`);
    return responseBody(response);
  };
  return {
    listCandidates: (query, limit) => get(`/v1/candidates?${new URLSearchParams({ ...(query ? { query } : {}), ...(limit ? { limit: String(limit) } : {}) })}`),
    getCandidateContext: (candidateId, selectedDomain, resumeId, sessionId) => {
      const query = new URLSearchParams({ ...(selectedDomain ? { selectedDomain } : {}), ...(resumeId ? { resumeId } : {}), ...(sessionId ? { sessionId } : {}) }).toString();
      return get(`/v1/candidates/${encodeURIComponent(candidateId)}/context${query ? `?${query}` : ""}`);
    },
    readArtifact: (candidateId, artifactKey) => get(`/v1/artifacts/${encodeURIComponent(artifactKey)}?${new URLSearchParams({ candidateId })}`)
  };
}

function baseUrl(config: FetchIngressConfig): string | null {
  const url = config.url?.trim(); const secret = config.sharedSecret?.trim();
  if (!url || !secret || !isHttpUrl(url)) return null;
  return new URL(url).origin;
}
function bearer(sharedSecret: string): HeadersInit { return { Authorization: `Bearer ${sharedSecret}`, "content-type": "application/json" }; }

function unavailableIngress(): IngressTransport {
  return { send: async () => { throw new Error("Ingress is not configured"); } };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
