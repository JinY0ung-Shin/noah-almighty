export interface DirectMessagePeer {
  id: string;
  username: string;
  displayName: string;
  online: boolean;
  available: boolean;
  unread: number;
}

export interface DirectMessage {
  id: number;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
  /** When the RECIPIENT opened it — `null` while unread. Monotonic per thread,
      so the sender's dock reads it as one 읽음 boundary rather than per-bubble
      state. Rows predating the field (an old mock) may omit it entirely. */
  readAt: string | null;
}

export interface DirectMessageInbox {
  peers: DirectMessagePeer[];
  unread: number;
  windowMinutes: number;
}

export interface DirectMessagePage {
  messages: DirectMessage[];
  hasMore: boolean;
}
