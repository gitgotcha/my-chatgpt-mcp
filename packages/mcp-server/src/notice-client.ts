export type SyncNotice = {
  code: string;
  message: string;
};

export interface NoticeClient {
  /** The Ingress GET endpoint consumes acknowledged notices, so each is shown once. */
  listNotices(userId: string): Promise<SyncNotice[]>;
}

export class DisabledNoticeClient implements NoticeClient {
  async listNotices(_userId: string): Promise<SyncNotice[]> {
    return [];
  }
}
