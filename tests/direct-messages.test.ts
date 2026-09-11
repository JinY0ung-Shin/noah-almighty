import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { signup, withTempDir } from "./helpers.js";

const dir = withTempDir("dm");
let services: ReturnType<typeof createServices>;
afterEach(() => { services?.store.close(); vi.useRealTimers(); });
async function setup() {
  services = createServices({ dataDir: dir(), agentRuntime: "local", sessionSecret: "test" });
  const app = createApp(services);
  const alice = request.agent(app), bob = request.agent(app), eve = request.agent(app);
  const a = (await signup(alice, "alice").expect(201)).body.user.id as string;
  const b = (await signup(bob, "bob").expect(201)).body.user.id as string;
  const e = (await signup(eve, "eve").expect(201)).body.user.id as string;
  return { app, alice, bob, eve, a, b, e };
}
const payload = (text: string, n = "1") => ({ text, nonce: `message-nonce-${n.padStart(8, "0")}` });

it("delivers between ordinary users, isolates history, and acknowledges only displayed arrivals", async () => {
  const { app, bob, eve, alice, a, b, e } = await setup();
  await request(app).get("/api/dm").expect(401);
  await request(app).post(`/api/dm/${b}`).send(payload("bad")).expect(401);
  const inbox = (await bob.get("/api/dm").expect(200)).body;
  expect(inbox.peers.map((p: { id: string }) => p.id)).toContain(e);
  expect(Object.keys(inbox.peers[0]).sort()).toEqual(["available", "displayName", "id", "online", "unread", "username"]);
  const first = (await bob.post(`/api/dm/${e}`).send(payload("비공개 메시지")).expect(201)).body.message;
  const second = (await bob.post(`/api/dm/${e}`).send(payload("나중에 도착", "2")).expect(201)).body.message;
  expect(first.readAt).toBe(null);
  // The sender's own view of read_at — the only thing a 읽음 receipt can be built on.
  const senderStamps = async (): Promise<Record<number, string | null>> => Object.fromEntries(
    ((await bob.get(`/api/dm/${e}`).expect(200)).body.messages as { id: number; readAt: string | null }[])
      .map(m => [m.id, m.readAt]));
  expect((await eve.get(`/api/dm/${b}`).expect(200)).body.messages).toHaveLength(2);
  expect((await alice.get(`/api/dm/${b}`).expect(200)).body.messages).toEqual([]);
  await alice.post(`/api/dm/${b}/read`).send({ throughId: second.id }).expect(200);
  expect((await eve.get("/api/dm")).body.unread).toBe(2);
  await eve.post(`/api/dm/${b}/read`).send({ throughId: first.id }).expect(200);
  expect((await eve.get("/api/dm")).body.unread).toBe(1);
  const acked = await senderStamps();
  expect(acked[first.id]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  expect(acked[second.id]).toBe(null);
  await eve.post(`/api/dm/${b}/read`).send({ throughId: second.id }).expect(200);
  expect((await eve.get("/api/dm")).body.unread).toBe(0);
  const bothAcked = await senderStamps();
  expect(bothAcked[second.id]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  // The earlier stamp does not move: read_at is set once, never re-stamped.
  expect(bothAcked[first.id]).toBe(acked[first.id]);
  await eve.post(`/api/dm/${b}`).send(payload("답장")).expect(201);
  expect((await bob.get("/api/dm")).body.unread).toBe(1);
  expect((await alice.get(`/api/dm/${a}`).expect(404)).body.error).toBeTruthy();
});

it("validates input, deduplicates retries, and limits delivery rate", async () => {
  const { bob, b, e } = await setup();
  await bob.post(`/api/dm/${e}`).send(payload(" ")).expect(400);
  await bob.post(`/api/dm/${e}`).send(payload("x".repeat(4001))).expect(400);
  await bob.post(`/api/dm/${e}`).send({ text: "hi" }).expect(400);
  await bob.post(`/api/dm/${b}`).send(payload("self")).expect(404);
  await bob.post("/api/dm/missing").send(payload("missing")).expect(404);
  await bob.get(`/api/dm/${e}?before=NaN`).expect(400);
  await bob.post(`/api/dm/${e}/read`).send({ throughId: -1 }).expect(400);
  const first = (await bob.post(`/api/dm/${e}`).send(payload("hello")).expect(201)).body.message;
  expect((await bob.post(`/api/dm/${e}`).send(payload("hello")).expect(200)).body.message).toEqual(first);
  await bob.post(`/api/dm/${e}`).send(payload("changed")).expect(409);
  for (let n = 2; n <= 60; n++) services.store.sendDirectMessage(b, e, `m${n}`, payload("", String(n)).nonce);
  await bob.post(`/api/dm/${e}`).send(payload("over limit", "61")).expect(429);
  await bob.post(`/api/dm/${e}`).send(payload("hello")).expect(200);
  const latest = (await bob.get(`/api/dm/${e}`)).body;
  expect(latest.messages).toHaveLength(50);
  expect(latest.hasMore).toBe(true);
  const older = (await bob.get(`/api/dm/${e}?before=${latest.messages[0].id}`)).body;
  expect(older.messages).toHaveLength(10);
  expect(older.hasMore).toBe(false);
  expect(older.messages[0]).toEqual(first);
});

it("expires presence, retains offline threads across restart, and cleans both user directions", async () => {
  const { bob, eve, a, b, e } = await setup();
  await bob.post(`/api/dm/${e}`).send(payload("persistent")).expect(201);
  await eve.post(`/api/dm/${b}`).send(payload("reply")).expect(201);
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = Date.now();
  vi.setSystemTime(startedAt + 59 * 60_000);
  const active = services.store.directMessageInbox(b);
  expect(active.windowMinutes).toBe(60);
  expect(active.peers.find(p => p.id === e)?.online).toBe(true);
  vi.setSystemTime(startedAt + 61 * 60_000);
  const inbox = (await bob.get("/api/dm")).body;
  expect(inbox.peers.find((p: { id: string }) => p.id === e).online).toBe(false);
  expect(inbox.peers.some((p: { id: string }) => p.id === a)).toBe(false);
  const reopened = new Store(services.config);
  expect(reopened.directMessageHistory(e, b).messages).toHaveLength(2);
  reopened.close();
  services.store.setSuspended(e, true);
  await bob.post(`/api/dm/${e}`).send(payload("blocked", "2")).expect(404);
  await eve.get("/api/dm").expect(401);
  expect((await bob.get("/api/dm")).body.peers[0].available).toBe(false);
  services.store.deleteUser(e);
  expect(services.store.directMessageHistory(b, e).messages).toEqual([]);
  expect((await bob.get("/api/dm")).body.peers).toEqual([]);
});
