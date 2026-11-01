export interface AvatarApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type AvatarTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/**
 * What the external API REPORTS: the stored status, or `waiting_input` when the
 * task's run has outstanding question/permission/canvas prompts. Derived
 * from the in-memory run registry at read time, never stored — it flips back
 * to `running` once the prompt is answered and is gone after a restart.
 */
export type AvatarTaskPresentedStatus = AvatarTaskStatus | "waiting_input";
export interface AvatarTask {
  id: string;
  ownerUserId: string;
  apiKeyId: string;
  conversationId: string;
  message: string;
  status: AvatarTaskStatus;
  runId: string | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  userMessagePersisted: boolean;
}
