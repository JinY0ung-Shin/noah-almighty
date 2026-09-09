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
