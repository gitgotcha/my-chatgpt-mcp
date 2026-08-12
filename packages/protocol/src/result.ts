export type SubmitResult = SyncSuccess | RetryableError | PermanentError;

export type SyncSuccess = {
  status: "success";
  eventId: string;
  syncedAt: string;
};

export type RetryableError = {
  status: "retryable_error";
  eventId: string;
  message: string;
  retryAfterMs?: number;
};

export type PermanentError = {
  status: "permanent_error";
  eventId: string;
  message: string;
};
