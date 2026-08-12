export type SyncNotice = {
  code: string;
  message: string;
};

export interface NoticeClient {
  listNotices(): Promise<SyncNotice[]>;
}

export class DisabledNoticeClient implements NoticeClient {
  async listNotices(): Promise<SyncNotice[]> {
    return [];
  }
}
