// Inbox knowledge-recording flow: the owner answers a pending request_info gap,
// and the avatar records the answer into its knowledge repo + resolves the
// request. Ported from the old inbox.js recordKnowledgeViaAvatar(). The recording
// reuses one cached per-user conversation thread ("지식 기록").
import { api } from "./api";
import { consumeSse } from "./sse";
import { readState } from "./state";
import type { KnowledgeRequest } from "./types";

function convKey(userId: string): string {
  return `knowledgeRecConv:${userId}`;
}
function getRecConv(userId: string): string | undefined {
  try {
    return localStorage.getItem(convKey(userId)) || undefined;
  } catch {
    return undefined;
  }
}
function setRecConv(userId: string, conversationId: string): void {
  try {
    localStorage.setItem(convKey(userId), conversationId);
  } catch {
    /* ignore */
  }
}

let inFlight = false;

export async function recordKnowledgeViaAvatar(request: KnowledgeRequest, answer: string): Promise<{ ok: boolean; error?: string }> {
  const avatarId = readState().user?.id;
  if (!avatarId) return { ok: false, error: "로그인이 필요합니다." };
  if (inFlight) return { ok: false, error: "다른 기록 요청을 처리하는 중이에요. 잠시 후 다시 시도해 주세요." };
  inFlight = true;
  try {
    const askerBit = request.askerName ? `동료 "${request.askerName}"가` : "한 동료가";
    const message =
      `${askerBit} 다음을 물었는데 내가 답하지 못했어:\n` +
      `"${request.question}"\n\n` +
      "아래 정보를 내 지식 저장소(knowledge repo)에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘. " +
      "적절한 스킬이나 문서에 반영하고 commit까지 해줘. 기록을 커밋한 뒤에는 이 정보 요청을 " +
      `resolve_request 도구로 닫아줘 (request_id: ${request.id}).\n\n` +
      `--- 기록할 내용 ---\n${answer}`;

    const prevConv = getRecConv(avatarId);
    let response: Response;
    try {
      response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ avatarId, message, conversationId: prevConv }),
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (response.status === 401) return { ok: false, error: "세션이 만료되었습니다." };
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }

    let convId: string | null = null;
    let runId: string | null = null;
    let errText: string | null = null;
    try {
      await consumeSse(response.body, ({ event, data }) => {
        if (event === "open") {
          if (data?.conversationId) convId = data.conversationId;
          if (data?.runId) runId = data.runId;
        } else if (event === "error") {
          errText = data?.error || "오류가 발생했습니다.";
        } else if (event === "question" && runId && data?.requestId) {
          // No prompt UI here: a question would park the run, so cancel it.
          api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId, requestId: data.requestId, value: { cancelled: true } }) }).catch(() => {});
        }
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message || "스트림 연결이 끊어졌습니다." };
    }

    if (convId && convId !== prevConv) {
      setRecConv(avatarId, convId);
      api(`/api/conversations/${encodeURIComponent(convId)}`, { method: "PATCH", body: JSON.stringify({ title: "지식 기록" }) }).catch(() => {});
    }
    if (errText) return { ok: false, error: errText };
    return { ok: true };
  } finally {
    inFlight = false;
  }
}
