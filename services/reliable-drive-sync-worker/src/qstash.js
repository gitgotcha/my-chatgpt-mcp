export class QStashPublishError extends Error {
  constructor(status) {
    super(`QStash rejected publish with HTTP ${status}`);
    this.name = "QStashPublishError";
    this.status = status;
  }
}

export function createQStashPublisher(token, fetchImpl = fetch, qstashUrl = "https://qstash-us-east-1.upstash.io") {
  const baseUrl = qstashUrl.replace(/\/+$/, "");
  return {
    async publish({ targetUrl, failureCallbackUrl, job }) {
      const response = await fetchImpl(`${baseUrl}/v2/publish/${targetUrl}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "upstash-failure-callback": failureCallbackUrl,
          "upstash-deduplication-id": job.jobId
        },
        body: JSON.stringify(job)
      });
      if (!response.ok) throw new QStashPublishError(response.status);
      return response.json();
    }
  };
}
