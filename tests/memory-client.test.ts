import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import { loadConfig, parseMemoryConfig } from "../src/server/config.js";
import { assertAllowedGitSource, GitSourceRefusedError } from "../src/server/gitSourcePolicy.js";
import {
  createHttpMemoryClient,
  memoryClientFor,
  MemoryRefusedError,
  MemoryUnavailableError,
  setMemoryClientForTests,
  type MemoryClient,
} from "../src/server/memory/memoryClient.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";
import { withTempDir } from "./helpers.js";

// The HTTP client of the memory service (memory/memoryClient.ts) against a tiny
// in-test server that answers with the service's documented shapes, plus the
// config that turns it on (PI_MEMORY_URL + PI_MEMORY_API_KEY_FILE).

const KEY = "memory-test-key-0123456789abcdef0123456789abcdef";
const OWNER = "3f2b6c1e-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

interface Seen {
  method: string;
  url: string;
  pathname: string;
  query: Record<string, string>;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Answer = { status: number; json?: unknown; raw?: string; headers?: Record<string, string> } | "hang";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A service that answers every request with what `answer` returns, and remembers what it was asked. */
async function service(answer: (seen: Seen) => Answer): Promise<{ url: string; seen: Seen[]; client: MemoryClient }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://service.invalid");
      const request: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(request);
      const reply = answer(request);
      if (reply === "hang") return;
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, client: createHttpMemoryClient({ url, apiKey: KEY, timeoutMs: 2000 }) };
}

const refusalBody = (code: string, message = `the service says ${code}`) => ({ error: { code, message } });

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, "expected the call to fail").toBeInstanceOf(Error);
  return error as Error;
}

/** Nothing a thrown error carries may hold the key. */
function expectNoKey(error: Error): void {
  expect(error.message).not.toContain(KEY);
  expect(String(error.stack)).not.toContain(KEY);
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(KEY);
}

describe("memory client: requests and answers", () => {
  it("lists notes, with and without a folder prefix, and sends the key as a bearer token", async () => {
    const notes = [
      { path: "CLAUDE.md", bytes: 12 },
      { path: "wiki/a.md", bytes: 3 },
    ];
    const { client, seen } = await service(() => ({ status: 200, json: { notes } }));
    expect(await client.list(OWNER)).toEqual(notes);
    expect(await client.list(OWNER, "wiki")).toEqual(notes);
    expect(seen.map((s) => [s.method, s.pathname, s.query])).toEqual([
      ["GET", `/wiki/${OWNER}/notes`, {}],
      ["GET", `/wiki/${OWNER}/notes`, { prefix: "wiki" }],
    ]);
    expect(seen.every((s) => s.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it("reads a whole note, and answers null for a note that does not exist", async () => {
    const { client, seen } = await service((req) =>
      req.query.path === "wiki/한글 노트.md"
        ? { status: 200, json: { path: "wiki/한글 노트.md", content: "본문\n", hash: HASH } }
        : { status: 404, json: refusalBody("not_found") },
    );
    expect(await client.read(OWNER, "wiki/한글 노트.md")).toEqual({ path: "wiki/한글 노트.md", content: "본문\n", hash: HASH });
    expect(await client.read(OWNER, "wiki/missing.md")).toBeNull();
    expect(seen[0].pathname).toBe(`/wiki/${OWNER}/note`);
  });

  it("creates without a hash and replaces with one", async () => {
    const { client, seen } = await service((req) => {
      const body = JSON.parse(req.body) as { path: string; hash?: string };
      return { status: 200, json: { path: body.path, hash: HASH, created: body.hash === undefined } };
    });
    expect(await client.put(OWNER, "wiki/a.md", "one")).toEqual({ path: "wiki/a.md", hash: HASH, created: true });
    expect(await client.put(OWNER, "wiki/a.md", "two", HASH)).toEqual({ path: "wiki/a.md", hash: HASH, created: false });
    expect(seen.map((s) => [s.method, s.pathname, s.contentType, JSON.parse(s.body)])).toEqual([
      ["PUT", `/wiki/${OWNER}/note`, "application/json", { path: "wiki/a.md", content: "one" }],
      ["PUT", `/wiki/${OWNER}/note`, "application/json", { path: "wiki/a.md", content: "two", hash: HASH }],
    ]);
  });

  it("removes a note, and treats an already-missing note as removed", async () => {
    const { client, seen } = await service((req) =>
      req.query.path === "wiki/gone.md" ? { status: 404, json: refusalBody("not_found") } : { status: 200, json: { path: req.query.path } },
    );
    await expect(client.remove(OWNER, "wiki/a.md", HASH)).resolves.toBeUndefined();
    await expect(client.remove(OWNER, "wiki/gone.md", HASH)).resolves.toBeUndefined();
    expect(seen.map((s) => [s.method, s.pathname, s.query])).toEqual([
      ["DELETE", `/wiki/${OWNER}/note`, { path: "wiki/a.md", hash: HASH }],
      ["DELETE", `/wiki/${OWNER}/note`, { path: "wiki/gone.md", hash: HASH }],
    ]);
  });

  it("searches with the query, limit and prefix, and passes hits and unscanned on", async () => {
    const hits = [{ path: "wiki/a.md", title: "A", tags: ["x", "y"], snippet: "…a…", score: 6 }];
    const { client, seen } = await service(() => ({ status: 200, json: { hits, unscanned: 7 } }));
    expect(await client.search(OWNER, "배포 절차", 11, "wiki")).toEqual({ hits, unscanned: 7 });
    expect(await client.search(OWNER, "x")).toEqual({ hits, unscanned: 7 });
    expect(seen.map((s) => [s.method, s.pathname, s.query])).toEqual([
      ["GET", `/wiki/${OWNER}/search`, { q: "배포 절차", limit: "11", prefix: "wiki" }],
      ["GET", `/wiki/${OWNER}/search`, { q: "x" }],
    ]);
  });

  it("deletes a whole wiki", async () => {
    const { client, seen } = await service(() => ({ status: 200, json: { deleted: true } }));
    await expect(client.deleteWiki(OWNER)).resolves.toBeUndefined();
    expect([seen[0].method, seen[0].url]).toEqual(["DELETE", `/wiki/${OWNER}`]);
  });

  it("encodes the owner into the URL and tolerates a base URL with a trailing slash", async () => {
    const { url, seen } = await service(() => ({ status: 200, json: { notes: [] } }));
    const client = createHttpMemoryClient({ url: `${url}/`, apiKey: KEY });
    await client.list("user@corp.example");
    expect(seen[0].url).toBe("/wiki/user%40corp.example/notes");
  });

  it("refuses an owner that is not a user id without sending anything", async () => {
    const { client, seen } = await service(() => ({ status: 200, json: { notes: [] } }));
    for (const owner of ["", "..", "a/b", "../admin", "a b", "x".repeat(129)]) {
      const error = await caught(client.list(owner));
      expect(error).toBeInstanceOf(MemoryRefusedError);
      expect((error as MemoryRefusedError).code).toBe("invalid_owner");
    }
    expect(seen).toEqual([]);
  });
});

describe("memory client: refusals", () => {
  it.each([
    [409, "exists"],
    [409, "stale"],
    [413, "too_large"],
    [413, "body_too_large"],
    [400, "invalid_path"],
    [400, "invalid_content"],
    [400, "invalid_query"],
    [400, "invalid_request"],
    [400, "invalid_owner"],
    // The owner's wiki is full: a refusal the owner can act on, not an outage.
    [507, "wiki_full"],
  ])("a %i %s is a MemoryRefusedError carrying the service's code and message", async (status, code) => {
    const { client } = await service(() => ({ status, json: refusalBody(code) }));
    const error = await caught(client.put(OWNER, "wiki/a.md", "text"));
    expect(error).toBeInstanceOf(MemoryRefusedError);
    expect(error).not.toBeInstanceOf(MemoryUnavailableError);
    expect(error as MemoryRefusedError).toMatchObject({ code, status, message: `the service says ${code}` });
    expectNoKey(error);
  });

  it("a stale delete is refused; only `not_found` means it is already gone", async () => {
    const { client } = await service(() => ({ status: 409, json: refusalBody("stale") }));
    const error = await caught(client.remove(OWNER, "wiki/a.md", HASH));
    expect(error as MemoryRefusedError).toMatchObject({ code: "stale", status: 409 });
  });

  it("a `not_found` where no note was asked for is a refusal, not an empty answer", async () => {
    const { client } = await service(() => ({ status: 404, json: refusalBody("not_found") }));
    for (const call of [
      () => client.list(OWNER),
      () => client.search(OWNER, "q"),
      () => client.put(OWNER, "wiki/a.md", "x"),
      () => client.deleteWiki(OWNER),
    ]) {
      expect(await caught(call())).toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("never repeats the key, even when the service's message does", async () => {
    const { client } = await service(() => ({ status: 400, json: refusalBody("invalid_request", `bad token ${KEY} in request`) }));
    const error = await caught(client.read(OWNER, "wiki/a.md"));
    expect(error).toBeInstanceOf(MemoryRefusedError);
    expect(error.message).toBe("bad token [redacted] in request");
    expectNoKey(error);
  });
});

describe("memory client: the service cannot be used", () => {
  const everyCall = (client: MemoryClient): [string, () => Promise<unknown>][] => [
    ["list", () => client.list(OWNER)],
    ["read", () => client.read(OWNER, "wiki/a.md")],
    ["put", () => client.put(OWNER, "wiki/a.md", "x")],
    ["remove", () => client.remove(OWNER, "wiki/a.md", HASH)],
    ["search", () => client.search(OWNER, "q")],
    ["deleteWiki", () => client.deleteWiki(OWNER)],
  ];

  it.each<[string, Answer, string]>([
    ["401 unauthorized", { status: 401, json: refusalBody("unauthorized", `missing or invalid key ${KEY}`) }, "unauthorized"],
    ["404 no_route (a wrong address or an older service)", { status: 404, json: refusalBody("no_route") }, "no_route"],
    ["500 internal", { status: 500, json: refusalBody("internal") }, "server_error"],
    ["a 502 page from something in between", { status: 502, raw: "<html>Bad Gateway</html>" }, "server_error"],
    ["a 507 that is not wiki_full", { status: 507, json: refusalBody("internal") }, "server_error"],
    ["a 404 without the service's error body", { status: 404, raw: "Not Found" }, "bad_answer"],
    ["a 400 without a code", { status: 400, json: { message: "nope" } }, "bad_answer"],
    ["a 200 that is not JSON", { status: 200, raw: "<html>ok</html>" }, "bad_answer"],
    ["a 200 without the documented fields", { status: 200, json: { ok: true } }, "bad_answer"],
    ["a 204", { status: 204 }, "bad_answer"],
    ["a redirect", { status: 302, headers: { location: "http://127.0.0.1:9/elsewhere" } }, "network"],
  ])("%s is a MemoryUnavailableError on every call", async (_label, answer, reason) => {
    const { client } = await service(() => answer);
    for (const [op, call] of everyCall(client)) {
      const error = await caught(call());
      expect(error, op).toBeInstanceOf(MemoryUnavailableError);
      expect(error, op).not.toBeInstanceOf(MemoryRefusedError);
      expect((error as MemoryUnavailableError).reason, op).toBe(reason);
      expect(error.message, op).toMatch(/^memory service unavailable/);
      expectNoKey(error);
    }
  });

  it("a note read never turns an outage into `null`", async () => {
    const { client } = await service(() => ({ status: 404, json: refusalBody("no_route") }));
    await expect(client.read(OWNER, "wiki/a.md")).rejects.toBeInstanceOf(MemoryUnavailableError);
    await expect(client.remove(OWNER, "wiki/a.md", HASH)).rejects.toBeInstanceOf(MemoryUnavailableError);
  });

  it("wrong field types in an otherwise documented answer are a bad answer", async () => {
    const answers: Record<string, unknown> = {
      notes: { notes: [{ path: "wiki/a.md", bytes: "3" }] },
      note: { path: "wiki/a.md", content: 5, hash: HASH },
      search: { hits: [{ path: "wiki/a.md", title: "A", tags: "x", snippet: "", score: 1 }], unscanned: 0 },
    };
    const { client } = await service((req) => ({ status: 200, json: answers[req.pathname.split("/").pop() ?? ""] }));
    for (const call of [() => client.list(OWNER), () => client.read(OWNER, "wiki/a.md"), () => client.search(OWNER, "q")]) {
      expect(await caught(call())).toMatchObject({ name: "MemoryUnavailableError", reason: "bad_answer" });
    }
  });

  it("no answer in time is a timeout", async () => {
    const { url } = await service(() => "hang");
    const client = createHttpMemoryClient({ url, apiKey: KEY, timeoutMs: 60 });
    const error = await caught(client.read(OWNER, "wiki/a.md"));
    expect(error).toBeInstanceOf(MemoryUnavailableError);
    expect((error as MemoryUnavailableError).reason).toBe("timeout");
    expectNoKey(error);
  });

  it("nothing listening is a network error", async () => {
    const { url } = await service(() => ({ status: 200, json: {} }));
    await new Promise<void>((resolve) => servers.splice(0)[0].close(() => resolve()));
    const error = await caught(createHttpMemoryClient({ url, apiKey: KEY }).list(OWNER));
    expect(error).toBeInstanceOf(MemoryUnavailableError);
    expect((error as MemoryUnavailableError).reason).toBe("network");
    // Only the system's error code is passed on (ECONNREFUSED; ECONNRESET on some hosts).
    expect(error.message).toMatch(/^memory service unavailable \(list\): network error \(E[A-Z]+\)$/);
    expectNoKey(error);
  });

  it("a transport error's own text is never passed on", async () => {
    const client = createHttpMemoryClient({
      url: "http://memory.invalid",
      apiKey: KEY,
      fetch: () => Promise.reject(new TypeError(`fetch failed with Authorization: Bearer ${KEY}`)),
    });
    const error = await caught(client.list(OWNER));
    expect(error).toBeInstanceOf(MemoryUnavailableError);
    expect(error.message).toBe("memory service unavailable (list): network error");
    expectNoKey(error);
  });
});

describe("memory client: one per app instance", () => {
  const getTempDir = withTempDir("memory-client");
  const services = (overrides: Parameters<typeof createServices>[0] = {}) =>
    createServices({ dataDir: path.join(getTempDir(), "data"), agentRuntime: "local", sessionSecret: "t", ...overrides });

  it("is null without a memory configuration and one shared client with it", () => {
    const off = services();
    expect(memoryClientFor(off.store, off.config)).toBeNull();
    const on = createServices({
      dataDir: path.join(getTempDir(), "data-on"),
      agentRuntime: "local",
      sessionSecret: "t",
      memory: { url: "http://memory:7090", apiKey: KEY },
    });
    const client = memoryClientFor(on.store, on.config);
    expect(client).not.toBeNull();
    expect(memoryClientFor(on.store, on.config)).toBe(client);
  });

  it("a test-installed client wins until it is removed", () => {
    const { store, config } = services();
    const fake = createFakeMemoryClient();
    setMemoryClientForTests(store, fake);
    expect(memoryClientFor(store, config)).toBe(fake);
    setMemoryClientForTests(store, null);
    expect(memoryClientFor(store, config)).toBeNull();
  });
});

describe("memory service configuration", () => {
  const getTempDir = withTempDir("memory-config");
  const keyFile = (content = `${KEY}\n`) => {
    const file = path.join(getTempDir(), "memory_api_key");
    fs.writeFileSync(file, content);
    return file;
  };
  const parse = (values: Partial<{ url: string; apiKeyFile: string; inlineApiKey: string }>) =>
    parseMemoryConfig({ url: "", apiKeyFile: "", inlineApiKey: "", ...values });

  it("is off when neither the URL nor the key file is set", () => {
    expect(parse({})).toBeUndefined();
  });

  it("reads the key from the file and drops a trailing slash of the URL", () => {
    expect(parse({ url: "http://memory:7090/", apiKeyFile: keyFile() })).toEqual({ url: "http://memory:7090", apiKey: KEY });
    expect(parse({ url: "https://memory.corp.example/base/", apiKeyFile: keyFile() })?.url).toBe("https://memory.corp.example/base");
  });

  it("stops the boot on an inline key, without repeating it", () => {
    for (const values of [{ inlineApiKey: KEY }, { inlineApiKey: KEY, url: "http://memory:7090", apiKeyFile: keyFile() }]) {
      let message = "";
      try {
        parse(values);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^PI_MEMORY_API_KEY is not read: .*PI_MEMORY_API_KEY_FILE/);
      expect(message).not.toContain(KEY);
    }
  });

  it("stops the boot on half a configuration", () => {
    expect(() => parse({ url: "http://memory:7090" })).toThrow(/needs both PI_MEMORY_URL and PI_MEMORY_API_KEY_FILE/);
    expect(() => parse({ apiKeyFile: keyFile() })).toThrow(/needs both PI_MEMORY_URL and PI_MEMORY_API_KEY_FILE/);
  });

  it("stops the boot on a URL that is not an absolute http(s) address", () => {
    const apiKeyFile = keyFile();
    expect(() => parse({ url: "memory:7090/x y", apiKeyFile })).toThrow(/PI_MEMORY_URL must be/);
    expect(() => parse({ url: "/memory", apiKeyFile })).toThrow(/PI_MEMORY_URL must be an absolute URL/);
    expect(() => parse({ url: "ftp://memory:7090", apiKeyFile })).toThrow(/PI_MEMORY_URL must be an http\(s\) URL/);
    expect(() => parse({ url: "http://user:pw@memory:7090", apiKeyFile })).toThrow(/must not carry credentials/);
    expect(() => parse({ url: "http://memory:7090/?x=1", apiKeyFile })).toThrow(/must not carry a query or fragment/);
  });

  it("stops the boot on a key file that is missing, empty or not one line — never quoting its content", () => {
    const missing = path.join(getTempDir(), "nope");
    expect(() => parse({ url: "http://memory:7090", apiKeyFile: missing })).toThrow(`PI_MEMORY_API_KEY_FILE (${missing}) cannot be read (ENOENT).`);
    expect(() => parse({ url: "http://memory:7090", apiKeyFile: keyFile("\n") })).toThrow(/is empty\.$/);
    let message = "";
    try {
      parse({ url: "http://memory:7090", apiKeyFile: keyFile(`${KEY}\nsecond-line\n`) });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must hold the key alone on one line\.$/);
    expect(message).not.toContain(KEY);
  });

  it("loadConfig reads the environment, and an override replaces it", () => {
    const names = ["PI_MEMORY_URL", "PI_MEMORY_API_KEY_FILE", "PI_MEMORY_API_KEY"] as const;
    const saved = names.map((name) => process.env[name]);
    const base = { dataDir: path.join(getTempDir(), "data"), agentRuntime: "local" as const, sessionSecret: "t" };
    try {
      for (const name of names) delete process.env[name];
      expect(loadConfig(base).memory).toBeUndefined();
      process.env.PI_MEMORY_URL = "http://memory:7090";
      expect(() => loadConfig(base)).toThrow(/needs both/);
      process.env.PI_MEMORY_API_KEY_FILE = keyFile();
      expect(loadConfig(base).memory).toEqual({ url: "http://memory:7090", apiKey: KEY });
      // The key read from the file is never written to the environment.
      expect(process.env.PI_MEMORY_API_KEY).toBeUndefined();
      expect(loadConfig({ ...base, memory: { url: "http://other:1", apiKey: "k" } }).memory).toEqual({ url: "http://other:1", apiKey: "k" });
      process.env.PI_MEMORY_API_KEY = KEY;
      expect(() => loadConfig(base)).toThrow(/PI_MEMORY_API_KEY is not read/);
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });

  it("the memory service is one of Noah's internal services: never a git source", async () => {
    const policy = {
      dataDir: path.join(getTempDir(), "data"),
      githubHost: "git.corp.example",
      defaultPluginsDir: path.join(getTempDir(), "default-skills"),
      pi: undefined,
    };
    const withMemory = { ...policy, memory: { url: "http://memory:7090", apiKey: KEY } };
    for (const source of ["http://memory:7090/wiki/x.git", "http://MEMORY:7090/x.git", "git://memory:7090/x.git"]) {
      await expect(assertAllowedGitSource(source, withMemory)).rejects.toBeInstanceOf(GitSourceRefusedError);
    }
    // Refused by identity only: the same source is fine for a server without that memory service.
    await expect(assertAllowedGitSource("http://memory:7090/wiki/x.git", policy)).resolves.toMatchObject({ kind: "remote" });
  });
});
