export type QStashJobMessage = { jobId: string; eventKey: string; userId: string };

export type QStashPublishRequest = {
  targetUrl: string;
  failureCallbackUrl: string;
  job: QStashJobMessage;
};

export interface QStashPublisher {
  publish(request: QStashPublishRequest): Promise<unknown>;
}

/** Contains only the upstream status; tokens and response bodies never escape this boundary. */
export class QStashPublishError extends Error {
  constructor(readonly status: number) {
    super(`QStash rejected publish with HTTP ${status}`);
    this.name = "QStashPublishError";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const defaultQStashUrl = "https://qstash.upstash.io";

/** The token stays within this boundary and is never added to JSON or errors. */
export function createQStashPublisher(
  token: string,
  fetchLike: FetchLike = fetch,
  qstashUrl = defaultQStashUrl
): QStashPublisher {
  const baseUrl = qstashUrl.replace(/\/+$/, "");
  return {
    async publish(request: QStashPublishRequest): Promise<unknown> {
      const response = await fetchLike(`${baseUrl}/v2/publish/${request.targetUrl}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "upstash-failure-callback": request.failureCallbackUrl,
          "upstash-deduplication-id": request.job.jobId
        },
        body: JSON.stringify(request.job)
      });
      if (!response.ok) throw new QStashPublishError(response.status);
      return response.json();
    }
  };
}
