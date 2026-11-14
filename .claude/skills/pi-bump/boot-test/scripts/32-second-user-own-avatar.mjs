#!/usr/bin/env node
// C (extra): the SECOND (non-admin) user attaching a document on THEIR OWN avatar — allowed, and it lands in
// their own sandbox, never in the first user's. Plus pi's status route through the /admin proxy.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { W, check, client, dind, fake, finish, loadState, sha256, textOf, turn } from "./e2e-common.mjs";
const state = loadState();
const second = client(state.second.cookie);
const userKey = (p) => `u-${createHash("sha256").update(p, "utf8").digest("hex").slice(0, 24)}`;
const KEY = `own-${Date.now().toString(36)}`;
const doc = Buffer.from("# 두 번째 사용자의 메모\nOWN-MARK-2C7\n");
await fake.enqueue(KEY, [{ text: "확인.", toolCalls: [{ name: "bash", arguments: { command: "sha256sum /workspace/uploads/*; ls /workspace/uploads | wc -l" } }] }, { text: "읽었습니다." }]);
const t = await turn(second, { avatarId: state.second.id, conversationId: randomUUID(), message: `내 메모 읽어 줘 [[fake:${KEY}]]`, files: [{ name: "mate-own.md", data: `data:text/markdown;base64,${doc.toString("base64")}` }] });
check("the second user's document turn on their OWN avatar completes", t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0, `status ${t.status} ${JSON.stringify(t.json ?? t.of("error"))}`);
const reqs = await fake.requests(KEY);
const result = textOf((reqs[1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
check("their sandbox holds exactly that one upload, byte-identical", result.includes(`${sha256(doc)}  /workspace/uploads/mate-own.md`) && /\n1\s*$/.test(result.trimEnd() + "\n".slice(0, 0)) , JSON.stringify(result));
const mine = `${W}/home/workspaces/${userKey(state.second.id)}/uploads/mate-own.md`;
const theirs = `${W}/home/workspaces/${userKey(state.owner.id)}/uploads/mate-own.md`;
check("on the host: in the second user's workspace, NOT in the first user's", existsSync(mine) && sha256(readFileSync(mine)) === sha256(doc) && !existsSync(theirs));
console.log(dind("docker", "ps", "--filter", "label=pi-gateway.sandbox=1", "--format", "{{.Names}}\t{{.Image}}").trim());
const admin = client(state.owner.cookie);
const status = await admin.get("/admin/api/status");
console.log("GET /admin/api/status →", status.status, (await status.text()).slice(0, 500));
finish();
