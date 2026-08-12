import type { IngressResponse, IngressTransport } from "./submit-event.js";

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
