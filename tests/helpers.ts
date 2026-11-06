import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach } from "vitest";

type Agent = ReturnType<typeof request.agent>;
type SignupResponse = Awaited<ReturnType<Agent["post"]>>;

/**
 * The first account an app signed up through `signup` (the bootstrap admin),
 * keyed by the supertest agent's app. Signup mode is `approval` by default
 * since the single-team conversion (2026-11-06): every later account starts
 * pending, and approving it IS joining the team. `signup(...).expect(201)`
 * then plays the admin's part through the real admin API.
 */
const bootstrapAdmins = new WeakMap<object, Agent>();

/** The express app behind a supertest agent (each agent wraps it in its own http.Server). */
function appOf(agent: Agent): object {
  const server = (agent as unknown as { app: { listeners?: (event: string) => unknown[] } }).app;
  return (server.listeners?.("request")[0] as object | undefined) ?? server;
}

/**
 * Sign up a user. `await signup(...)` returns the raw signup response;
 * `signup(...).expect(status)` asserts the status like supertest, EXCEPT that
 * `.expect(201)` on a pending (202) signup approves the account as the app's
 * bootstrap admin (`POST /api/admin/users/:id/suspend`) and logs it in, then
 * resolves with that login response (`body.user`, session cookie on `agent`) —
 * so a multi-user test reads as before: everyone approved is a teammate.
 */
export function signup(agent: Agent, username: string, password = "password123") {
  const send = () => agent.post("/api/auth/signup").send({ username, displayName: username, password });
  return {
    then<T1 = SignupResponse, T2 = never>(
      onFulfilled?: ((res: SignupResponse) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      return send().then(onFulfilled, onRejected);
    },
    async expect(status: number): Promise<SignupResponse> {
      const res = await send();
      if (res.status === 201 && (res.body?.user?.roles as string[] | undefined)?.includes("admin")) {
        bootstrapAdmins.set(appOf(agent), agent);
      }
      if (status === 201 && res.status === 202 && res.body?.pending === true) {
        const admin = bootstrapAdmins.get(appOf(agent));
        if (!admin) {
          throw new Error(`signup(${username}) is pending approval and no bootstrap admin signed up through signup() on this app`);
        }
        const users = await admin.get("/api/admin/users").expect(200);
        const pending = (users.body.users as { id: string; username: string }[]).find((u) => u.username === username);
        if (!pending) throw new Error(`pending user ${username} not listed`);
        await admin.post(`/api/admin/users/${pending.id}/suspend`).send({ suspended: false }).expect(200);
        return agent.post("/api/auth/login").send({ username, password }).expect(200);
      }
      if (res.status !== status) {
        throw new Error(`expected ${status} from signup(${username}), got ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return res;
    },
  };
}

/** Parse SSE text into a list of {event, data} frames. */
export function parseSse(raw: string): { event: string; data: unknown }[] {
  const frames: { event: string; data: unknown }[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) {
      frames.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  return frames;
}

/**
 * Register beforeEach/afterEach hooks that mint a fresh temp dir under
 * `noah-<label>-` and remove it after each test. Returns an accessor for the
 * current path. `onSetup` runs inside beforeEach after the dir is created.
 */
export function withTempDir(label: string, onSetup?: () => void): () => string {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `noah-${label}-`));
    onSetup?.();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

export function rpcClient(proc: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : null;
      if (id !== null) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    }
  });
  return {
    request(method: string, params?: Record<string, unknown>) {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }, 1000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
  };
}

/** Initialise a local git repo at `dir` with a single committed file and return its HEAD sha. */
export function gitInit(dir: string, seedFile = "README.md"): string {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, seedFile), "hello");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return git("rev-parse", "HEAD");
}

/** Create a bare git remote with a `main` default branch (so `ensureClone` has a branch to track). */
export function makeBareRemote(remote: string): string {
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
  return remote;
}

/** Invoke an in-process MCP tool's handler by name, asserting it exists. */
export function callTool<T extends { name: string; handler: unknown }>(
  tools: readonly T[],
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
}

/** Turn `dir` into a valid single-plugin repo (`.claude-plugin/plugin.json`). */
export function makePluginRepo(dir: string, name = "p"): string {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return gitInit(dir, ".claude-plugin/plugin.json");
}

/**
 * Build a marketplace repo at `dir` listing `names` as relative `./plugins/<n>`
 * sources, each a valid single-plugin dir.
 */
export function makeMarketplaceRepo(dir: string, names: string[]): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  const plugins = names.map((n) => ({ name: n, source: `./plugins/${n}` }));
  fs.writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins }));
  for (const n of names) {
    const pdir = path.join(dir, "plugins", n, ".claude-plugin");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "plugin.json"), JSON.stringify({ name: n }));
  }
}

/** Write a `skills/<name>/SKILL.md` with the given frontmatter under `root`. */
export function makeSkill(root: string, name: string, frontmatter: string, body = ""): void {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n${body}`);
}
