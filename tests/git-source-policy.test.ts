import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp, createServices } from "../src/server/app.js";
import { buildGitRepoTools } from "../src/server/agent/gitRepoTools.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import {
  assertAllowedGitSource,
  gitSourceRefusalKorean,
  GitSourceRefusedError,
  parseIPv6,
  parseLooseIPv4,
  type GitSourceLookup,
} from "../src/server/gitSourcePolicy.js";
import { ensureGitRepoClone, gitRepoClonePath, gitRepoContextFor, pushGitRepo } from "../src/server/gitRepos.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { assertSafeGitValue } from "../src/server/repoGitGuards.js";
import { loadAvatarPluginRoots, pluginClonePath, syncPluginRepo } from "../src/server/plugins.js";
import { callTool, gitInit, makeBareRemote, makePluginRepo, signup, withTempDir } from "./helpers.js";

// Source policy of a user-registered git repository (gitSourcePolicy.ts): Noah
// clones it in its OWN container, so a local path inside Noah's directories and a
// host in an always-blocked class are refused at register_repo and at every
// later use. Before the policy existed every case below was reachable: an owner
// run cloned another user's clone / knowledge repo / the team-brain vault by
// path, and git connected to loopback in every textual form.

let tempDir: string;
const getTempDir = withTempDir("git-source-policy", () => {
  tempDir = getTempDir();
});

const REFUSED = /^Refused git source '/;
const NO_BASH = "Do not work around this with Bash `git clone` — the shell has no git credentials.";

function setup() {
  const dataDir = path.join(tempDir, "data");
  const { store, config } = createServices({
    dataDir,
    agentRuntime: "local",
    sessionSecret: "t",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false, workspacesDir: path.join(tempDir, "ws") },
  });
  const victim = store.createUser({ username: "victim", displayName: "V", password: "password123" });
  const attacker = store.createUser({ username: "attacker", displayName: "A", password: "password123" });
  const toolsFor = (id: string, username: string) =>
    buildGitRepoTools(store, {
      avatarUserId: id,
      owner: { id, username, displayName: username },
      viewerIsOwner: true,
      elevated: true,
      config,
      conversationId: `conv-${username}`,
      piWorkspace: piWorkspaceFor(config, id, `conv-${username}`),
    });
  // A remote OUTSIDE Noah's directories — the legitimate local source.
  const remote = makeBareRemote(path.join(tempDir, "outside", "remote.git"));
  const seed = path.join(tempDir, "outside", "seed");
  gitInit(seed, "SECRET.md");
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return { store, config, dataDir, victim, attacker, toolsFor, remote };
}

const cfg = (overrides: Partial<{ githubHost: string }> = {}) => ({
  dataDir: path.join(tempDir, "data"),
  githubHost: overrides.githubHost ?? "git.corp.example",
  defaultPluginsDir: path.join(tempDir, "default-skills"),
  pi: undefined,
});

const lookupOf =
  (table: Record<string, string[]>): GitSourceLookup =>
  async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected the source to be refused").toBeInstanceOf(GitSourceRefusedError);
  return (error as Error).message;
}

describe("git source policy — address parsing", () => {
  it("reads an IPv4 address in every inet_aton form", () => {
    for (const form of ["127.0.0.1", "2130706433", "0x7f000001", "0x7f.1", "0177.0.0.1", "127.1", "127.0.1", "0x7F.0x0.0x0.0x1", "017700000001"]) {
      expect(parseLooseIPv4(form), form).toEqual([127, 0, 0, 1]);
    }
    expect(parseLooseIPv4("0")).toEqual([0, 0, 0, 0]);
    expect(parseLooseIPv4("169.254.169.254")).toEqual([169, 254, 169, 254]);
    expect(parseLooseIPv4("2852039166")).toEqual([169, 254, 169, 254]);
    for (const name of ["example.com", "1e100.net", "256.1.1.1", "1.2.3.4.5", "08.1.1.1", "4294967296", "", "a.b"]) {
      expect(parseLooseIPv4(name), name).toBeNull();
    }
  });

  it("expands an IPv6 literal, including an embedded IPv4 tail and a zone", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:127.0.0.1")?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6("::ffff:7f00:1")?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6("fe80::1%eth0")?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(parseIPv6("not-ipv6")).toBeNull();
    expect(parseIPv6("127.0.0.1")).toBeNull();
  });
});

describe("git source policy — hosts", () => {
  it("refuses loopback, link-local and 0.0.0.0/8 hosts in every textual form", async () => {
    const blocked = [
      "http://127.0.0.1/x.git",
      "https://127.0.0.1:8443/x.git",
      "http://localhost/x.git",
      "http://LOCALHOST./x.git",
      "http://foo.localhost/x.git",
      "http://2130706433/x.git",
      "http://0x7f.1/x.git",
      "http://0177.0.0.1/x.git",
      "http://127.1/x.git",
      "http://0.0.0.0/x.git",
      "http://0/x.git",
      "http://0.1.2.3/x.git",
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/latest/meta-data/",
      "http://[::1]/x.git",
      "http://[::]/x.git",
      "http://[::ffff:127.0.0.1]/x.git",
      "http://[::ffff:7f00:1]/x.git",
      "http://[::ffff:169.254.169.254]/x.git",
      "http://[::127.0.0.1]/x.git",
      "http://[64:ff9b::7f00:1]/x.git",
      "http://[fe80::1]/x.git",
      "http://[fe80::1%25eth0]/x.git",
      "http://user:pw@127.0.0.1/x.git",
      "http://%31%32%37.0.0.1/x.git",
      "ssh://git@127.0.0.1/x.git",
      "ssh://git@%6cocalhost/x.git",
      "ssh://git@0x7f.1:2222/x.git",
      "git://127.0.0.1/x.git",
      "git@127.0.0.1:org/x.git",
      "git@localhost:org/x.git",
      "git@[::1]:org/x.git",
      "[127.0.0.1:2222]:org/x.git",
      "2130706433:org/x.git",
    ];
    for (const source of blocked) {
      const message = await refusal(assertAllowedGitSource(source, cfg()));
      expect(message, source).toMatch(REFUSED);
      expect(message, source).toContain(NO_BASH);
    }
  });

  it("names what was refused and what is allowed, never echoing URL credentials", async () => {
    const message = await refusal(assertAllowedGitSource("https://user:s3cret-token@127.0.0.1/x.git", cfg()));
    expect(message).toBe(
      "Refused git source 'https://***@127.0.0.1/x.git': host '127.0.0.1' is a loopback address. " +
        "Noah clones a registered repository inside its own server, so the source must be one of: " +
        "owner/repo on the configured git host (git.corp.example); " +
        "an https, http, ssh or git URL whose host is not a loopback, link-local (169.254.0.0/16, fe80::/10) or 0.0.0.0/8 address and not one of Noah's own internal services — a private-network host is fine; " +
        "or a local repository path outside Noah's own directories. Nothing was cloned, fetched or pushed. " +
        NO_BASH,
    );
    expect(message).not.toContain("s3cret-token");
  });

  it("keeps private-network and public hosts allowed", async () => {
    for (const source of [
      "https://10.20.30.40/org/repo.git",
      "https://192.168.1.10:8443/org/repo.git",
      "http://172.16.5.5/org/repo.git",
      "https://[fd00::10]/org/repo.git",
      "https://100.64.1.1/org/repo.git",
      "https://github.com/org/repo.git",
      "https://git.corp.example/org/repo.git",
      "git@git.corp.example:org/repo.git",
      "ssh://git@10.0.0.5:2222/org/repo.git",
      "git@10.0.0.5:org/repo.git",
    ]) {
      await expect(assertAllowedGitSource(source, cfg()), source).resolves.toMatchObject({ kind: "remote" });
    }
  });

  it("never judges the configured git host, even on loopback", async () => {
    const loopbackHost = cfg({ githubHost: "127.0.0.1:3000" });
    await expect(assertAllowedGitSource("https://127.0.0.1:3000/org/repo.git", loopbackHost, { resolve: true })).resolves.toEqual({
      kind: "remote",
      gitConfig: [],
    });
    // Only that exact host[:port]: another loopback port is still refused.
    await refusal(assertAllowedGitSource("https://127.0.0.1:9999/org/repo.git", loopbackHost));
    const named = cfg({ githubHost: "localhost" });
    await expect(assertAllowedGitSource("https://localhost/org/repo.git", named)).resolves.toMatchObject({ kind: "remote" });
    await expect(assertAllowedGitSource("git@localhost:org/repo.git", named)).resolves.toMatchObject({ kind: "remote" });
  });

  it("refuses a URL whose host git and Node would read differently", async () => {
    for (const source of ["https://git.corp.example\\@127.0.0.1/x.git", "https://exa mple.com/x.git", "https://example.com\t/x.git", "ssh://%zz/x.git"]) {
      expect(await refusal(assertAllowedGitSource(source, cfg())), source).toContain("cannot be read unambiguously");
    }
    // …and when the two readings differ, EACH is judged.
    await refusal(assertAllowedGitSource("https://example.com@127.0.0.1/x.git", cfg()));
  });

  it("resolves a name on network paths and refuses when ANY address is blocked", async () => {
    const lookup = lookupOf({
      "rebind.example": ["93.184.216.34", "127.0.0.1"],
      "metadata.example": ["169.254.169.254"],
      "mapped.example": ["::ffff:127.0.0.1"],
      "v6loop.example": ["::1"],
      "linklocal6.example": ["fe80::1%eth0"],
      "zero.example": ["0.0.0.0"],
      "internal-git.example": ["10.1.2.3"],
      "public.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    });
    for (const [host, shown] of [
      ["rebind.example", "resolves to 127.0.0.1, a loopback address"],
      ["metadata.example", "resolves to 169.254.169.254, a link-local address"],
      ["mapped.example", "resolves to ::ffff:127.0.0.1, a loopback address in its IPv6 form"],
      ["v6loop.example", "resolves to ::1, a loopback address"],
      ["linklocal6.example", "resolves to fe80::1%eth0, a link-local address (fe80::/10)"],
      ["zero.example", "resolves to 0.0.0.0, a 0.0.0.0/8"],
    ] as const) {
      const message = await refusal(assertAllowedGitSource(`https://${host}/org/repo.git`, cfg(), { resolve: true, lookup, env: {} }));
      expect(message, host).toContain(`host '${host}' ${shown}`);
      // scp-like and ssh:// sources are resolved the same way.
      await refusal(assertAllowedGitSource(`git@${host}:org/repo.git`, cfg(), { resolve: true, lookup, env: {} }));
      await refusal(assertAllowedGitSource(`ssh://git@${host}/org/repo.git`, cfg(), { resolve: true, lookup, env: {} }));
      // Without `resolve` (no network use) a name is not looked up.
      await expect(assertAllowedGitSource(`https://${host}/org/repo.git`, cfg(), { lookup })).resolves.toMatchObject({ kind: "remote" });
    }
    await expect(assertAllowedGitSource("https://internal-git.example/org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toMatchObject({
      kind: "remote",
    });
  });

  it("pins an external http(s) host to the checked addresses and turns redirects off", async () => {
    const lookup = lookupOf({
      "public.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      "git.corp.example": ["127.0.0.1"],
    });
    await expect(assertAllowedGitSource("https://public.example/org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [
        ["http.followRedirects", "false"],
        ["http.curloptResolve", "public.example:443:93.184.216.34,[2606:2800:220:1:248:1893:25c8:1946]"],
      ],
    });
    await expect(assertAllowedGitSource("http://Public.Example:8080/org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [
        ["http.followRedirects", "false"],
        ["http.curloptResolve", "public.example:8080:93.184.216.34,[2606:2800:220:1:248:1893:25c8:1946]"],
      ],
    });
    // Static use (no network): redirects are still off, nothing is resolved.
    await expect(assertAllowedGitSource("https://public.example/org/repo.git", cfg(), { lookup })).resolves.toEqual({
      kind: "remote",
      gitConfig: [["http.followRedirects", "false"]],
    });
    // A literal address needs no pin; ssh is not an http transport.
    await expect(assertAllowedGitSource("https://10.1.2.3/org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [["http.followRedirects", "false"]],
    });
    await expect(assertAllowedGitSource("git@public.example:org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [],
    });
    // The configured git host is the operator's: never resolved, redirects left to git's default.
    await expect(assertAllowedGitSource("https://git.corp.example/org/repo.git", cfg(), { resolve: true, lookup, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [],
    });
  });

  it("lets git report its own error when the name cannot be resolved (offline, egress proxy)", async () => {
    const failing: GitSourceLookup = async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    };
    await expect(assertAllowedGitSource("https://unknown.example/x.git", cfg(), { resolve: true, lookup: failing, env: {} })).resolves.toEqual({
      kind: "remote",
      gitConfig: [["http.followRedirects", "false"]],
    });
    const hanging: GitSourceLookup = () => new Promise(() => {});
    await expect(
      assertAllowedGitSource("https://slow.example/x.git", cfg(), { resolve: true, lookup: hanging, lookupTimeoutMs: 20, env: {} }),
    ).resolves.toMatchObject({ kind: "remote" });
  });

  it("does not judge Noah's own DNS answer for a host that git reaches through a proxy", async () => {
    // A corporate resolver that sinkholes external names, with the real route being the proxy.
    const lookup = lookupOf({ "external.example": ["0.0.0.0"], "direct.corp.example": ["127.0.0.1"] });
    const proxied = { https_proxy: "http://proxy.corp.example:3128", no_proxy: "localhost,.corp.example" };
    await expect(
      assertAllowedGitSource("https://external.example/org/repo.git", cfg(), { resolve: true, lookup, env: proxied }),
    ).resolves.toEqual({ kind: "remote", gitConfig: [["http.followRedirects", "false"]] });
    // Without the proxy the same answer is refused…
    await refusal(assertAllowedGitSource("https://external.example/org/repo.git", cfg(), { resolve: true, lookup, env: {} }));
    // …as is a host the proxy is bypassed for (no_proxy), an http URL when only https is proxied, and ssh.
    await refusal(assertAllowedGitSource("https://direct.corp.example/org/repo.git", cfg(), { resolve: true, lookup, env: proxied }));
    await refusal(assertAllowedGitSource("http://external.example/org/repo.git", cfg(), { resolve: true, lookup, env: proxied }));
    await refusal(assertAllowedGitSource("git@external.example:org/repo.git", cfg(), { resolve: true, lookup, env: proxied }));
    await refusal(
      assertAllowedGitSource("https://external.example/org/repo.git", cfg(), { resolve: true, lookup, env: { ...proxied, no_proxy: "*" } }),
    );
    // A literal blocked address is refused whatever the proxy settings.
    await refusal(assertAllowedGitSource("https://127.0.0.1/org/repo.git", cfg(), { resolve: true, lookup, env: proxied }));
  });

  it("refuses Noah's own internal services by name, by address and by what a name resolves to", async () => {
    const config = {
      ...cfg(),
      egressControlUrl: "http://172.30.0.3:3129",
      pi: {
        gatewayUrl: "http://pi-gateway:8080",
        apiKey: "k",
        deckSandbox: false,
        mcpPublicUrl: "http://noah-almighty:48787",
      },
    };
    const lookup = lookupOf({
      "pi-gateway": ["172.30.0.2"],
      "noah-almighty": ["172.30.0.4"],
      "alias.corp.example": ["172.30.0.2"],
      "other.corp.example": ["172.30.0.9"],
    });
    // Static (every use): the configured name or literal address, on the service's port.
    for (const [source, host] of [
      ["http://pi-gateway:8080/v1/models", "pi-gateway"],
      ["http://PI-GATEWAY:8080/x.git", "pi-gateway"],
      ["http://noah-almighty:48787/mcp/system", "noah-almighty"],
      ["http://172.30.0.3:3129/x.git", "172.30.0.3"],
      ["http://2887647235:3129/x.git", "2887647235"],
      ["git://pi-gateway:8080/x.git", "pi-gateway"],
      ["ssh://git@pi-gateway:8080/x.git", "pi-gateway"],
      ["[pi-gateway:8080]:org/x.git", "pi-gateway"],
    ] as const) {
      const error = await assertAllowedGitSource(source, config).then(
        () => null,
        (caught: unknown) => caught as GitSourceRefusedError,
      );
      expect(error, source).toBeInstanceOf(GitSourceRefusedError);
      expect(error!.code, source).toBe("internal_service");
      expect(error!.message, source).toContain(`host '${host}' is one of Noah's own internal services`);
      expect(error!.message, source).toContain(NO_BASH);
    }
    // With the network in play: the service's address, or another name for it.
    expect(await refusal(assertAllowedGitSource("http://172.30.0.2:8080/x.git", config, { resolve: true, lookup, env: {} }))).toContain(
      "host '172.30.0.2' is one of Noah's own internal services",
    );
    expect(await refusal(assertAllowedGitSource("http://[::ffff:172.30.0.2]:8080/x.git", config, { resolve: true, lookup, env: {} }))).toContain(
      "is one of Noah's own internal services",
    );
    expect(await refusal(assertAllowedGitSource("http://alias.corp.example:8080/x.git", config, { resolve: true, lookup, env: {} }))).toContain(
      "host 'alias.corp.example' resolves to 172.30.0.2, one of Noah's own internal services",
    );
    // Another port on that host, or another private host on that port, is not the service.
    for (const source of ["https://pi-gateway/org/repo.git", "git@pi-gateway:org/repo.git", "http://172.30.0.2:3000/x.git", "http://other.corp.example:8080/x.git"]) {
      await expect(assertAllowedGitSource(source, config, { resolve: true, lookup, env: {} }), source).resolves.toMatchObject({ kind: "remote" });
    }
    // The configured git host wins when it is the same host[:port].
    await expect(
      assertAllowedGitSource("http://pi-gateway:8080/org/repo.git", { ...config, githubHost: "pi-gateway:8080" }, { resolve: true, lookup, env: {} }),
    ).resolves.toEqual({ kind: "remote", gitConfig: [] });
  });

  it("renders a refusal in Korean for user-facing surfaces, without the server path or address", async () => {
    const config = { ...cfg(), pi: { gatewayUrl: "http://pi-gateway:8080", apiKey: "k", deckSandbox: false } };
    const korean = async (source: string) =>
      gitSourceRefusalKorean(
        (await assertAllowedGitSource(source, config).then(
          () => null,
          (caught: unknown) => caught,
        )) as GitSourceRefusedError,
      );
    const tail = "사내 git 호스트의 owner/repo 또는 외부에서 접근할 수 있는 git/https 주소를 입력해 주세요.";
    expect(await korean(path.join(config.dataDir, "git-repos", "u", "r", ".git"))).toBe(`Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다. ${tail}`);
    expect(await korean("http://127.0.0.1/x.git")).toBe(`서버 자신을 가리키는 주소(loopback·link-local·0.0.0.0)는 저장소 주소로 쓸 수 없습니다. ${tail}`);
    expect(await korean("http://pi-gateway:8080/x.git")).toBe(`Noah 내부 서비스의 주소는 저장소 주소로 쓸 수 없습니다. ${tail}`);
    expect(await korean("https://exa mple.com/x.git")).toBe("저장소 주소의 호스트를 읽을 수 없습니다. 주소를 다시 확인해 주세요.");
  });

  it("leaves arg-safety a separate layer that still accepts local paths", () => {
    expect(() => assertSafeGitValue("/srv/git/repo.git", "repo")).not.toThrow();
    expect(() => assertSafeGitValue("http://127.0.0.1/x.git", "repo")).not.toThrow();
    expect(() => assertSafeGitValue("--upload-pack=x", "repo")).toThrow();
    expect(() => assertSafeGitValue("ext::sh -c id", "repo")).toThrow();
  });
});

describe("git source policy — local paths", () => {
  it("refuses a path inside Noah's directories in every spelling, judging a missing path by its nearest ancestor", async () => {
    const config = cfg();
    const dataDir = config.dataDir;
    fs.mkdirSync(path.join(dataDir, "git-repos", "u1", "repo"), { recursive: true });
    const link = path.join(tempDir, "innocent-link");
    fs.symlinkSync(path.join(dataDir, "git-repos", "u1", "repo"), link);
    const linkedParent = path.join(tempDir, "linked-parent");
    fs.symlinkSync(dataDir, linkedParent);
    const inside = [
      dataDir,
      path.join(dataDir, "git-repos", "u1", "repo"),
      path.join(dataDir, "git-repos", "u1", "repo", ".git"),
      `${path.join(dataDir, "knowledge", "u2")}/`,
      path.join(dataDir, "team-brain"),
      path.join(dataDir, "does", "not", "exist", "yet.git"),
      path.join(dataDir, "..", "data", "git-repos"),
      `file://${path.join(dataDir, "git-repos", "u1", "repo")}`,
      `file://localhost${path.join(dataDir, "git-repos", "u1", "repo")}`,
      `file://${path.join(dataDir, "git-repos", "u1", "repo").replace("git-repos", "git%2Drepos")}`,
      link,
      path.join(linkedParent, "git-repos", "u1", "repo"),
      path.join(linkedParent, "not-there-yet.git"),
      config.defaultPluginsDir,
      process.cwd(),
      path.join(process.cwd(), "data", "git-repos"),
      "data/git-repos/u1/repo",
      "./node_modules",
      "some-relative-name",
    ];
    for (const source of inside) {
      const message = await refusal(assertAllowedGitSource(source, config));
      expect(message, source).toContain("the local path resolves inside");
      expect(message, source).toContain(NO_BASH);
    }
    const withWorkspaces = { ...config, pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false, workspacesDir: path.join(tempDir, "ws") } };
    expect(await refusal(assertAllowedGitSource(path.join(tempDir, "ws", "u1", "repos", "u1", "app"), withWorkspaces))).toContain(
      "inside the sandbox workspaces Noah manages",
    );
  });

  it("allows a local repository outside Noah's directories, existing or not", async () => {
    const config = cfg();
    const outside = path.join(tempDir, "outside-remote.git");
    for (const source of [outside, `file://${outside}`, path.join(tempDir, "data-sibling", "x.git"), `${config.dataDir}-backup/x.git`]) {
      await expect(assertAllowedGitSource(source, config), source).resolves.toEqual({ kind: "local", gitConfig: [] });
    }
  });
});

describe("register_repo and later use", () => {
  it("refuses another user's clone, knowledge repo, the team-brain vault and the sandbox mount — and still clones a legitimate local remote", async () => {
    const s = setup();
    const registered = await callTool(s.toolsFor(s.victim.id, "victim"), "register_repo", { repo: s.remote, name: "secret", branch: "main" });
    expect(registered.isError).toBeFalsy();
    const victimClone = gitRepoClonePath(s.victim.id, "secret", s.config);
    expect(fs.existsSync(path.join(victimClone, "SECRET.md"))).toBe(true);
    const victimKnowledge = knowledgeClonePath(s.victim.id, s.config);
    gitInit(victimKnowledge, "PRIVATE-NOTE.md");
    const vault = path.join(s.dataDir, "team-brain");
    if (!fs.existsSync(path.join(vault, ".git"))) gitInit(vault, "VAULT.md");
    const link = path.join(tempDir, "innocent-link.git");
    fs.symlinkSync(victimClone, link);
    const sandboxCopy = path.join(tempDir, "ws", "someone", "repos", "x");
    gitInit(sandboxCopy, "COPY.md");

    const attackerTools = s.toolsFor(s.attacker.id, "attacker");
    const sources = [victimClone, `${victimClone}/.git`, victimKnowledge, vault, link, `file://${victimClone}`, s.dataDir, sandboxCopy];
    for (const [index, repo] of sources.entries()) {
      const name = `steal${index}`;
      const res = await callTool(attackerTools, "register_repo", { repo, name });
      expect(res.isError, repo).toBe(true);
      expect(res.content[0]?.text, repo).toMatch(REFUSED);
      expect(res.content[0]?.text, repo).toContain(NO_BASH);
      // Nothing stored, nothing cloned.
      expect(s.store.getGitRepo(s.attacker.id, name)).toBeNull();
      expect(fs.existsSync(gitRepoClonePath(s.attacker.id, name, s.config))).toBe(false);
    }
    expect(s.store.listGitRepos(s.attacker.id)).toHaveLength(0);
    // The attacker's own legitimate source keeps working.
    const own = await callTool(attackerTools, "register_repo", { repo: s.remote, name: "mine", branch: "main" });
    expect(own.isError).toBeFalsy();
  });

  it("never lets git connect to a blocked host", async () => {
    const s = setup();
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.headers.host} ${req.url}`);
      res.statusCode = 404;
      res.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const tools = s.toolsFor(s.attacker.id, "attacker");
      const hosts = ["127.0.0.1", "localhost", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "0.0.0.0", "0", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::]"];
      for (const [index, host] of hosts.entries()) {
        const res = await callTool(tools, "register_repo", { repo: `http://${host}:${port}/probe${index}.git`, name: `u${index}` });
        expect(res.isError, host).toBe(true);
        expect(res.content[0]?.text, host).toMatch(REFUSED);
      }
      expect(hits).toEqual([]);
      expect(s.store.listGitRepos(s.attacker.id)).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a repo registered BEFORE the policy at every use, with the same message, and keeps its row", async () => {
    const s = setup();
    await callTool(s.toolsFor(s.victim.id, "victim"), "register_repo", { repo: s.remote, name: "secret", branch: "main" });
    const victimClone = gitRepoClonePath(s.victim.id, "secret", s.config);
    // As an older version stored and cloned it: the row and a working clone of another user's clone.
    s.store.upsertGitRepo(s.attacker.id, "old", victimClone, "main");
    const attackerClone = gitRepoClonePath(s.attacker.id, "old", s.config);
    fs.mkdirSync(path.dirname(attackerClone), { recursive: true });
    execFileSync("git", ["clone", "-q", victimClone, attackerClone], { stdio: "pipe" });
    s.store.upsertGitRepo(s.attacker.id, "oldhost", "http://127.0.0.1:9/x.git", null);

    const tools = s.toolsFor(s.attacker.id, "attacker");
    const expected = await refusal(assertAllowedGitSource(victimClone, s.config));
    for (const [tool, args] of [
      ["sync_repo", { name: "old" }],
      ["open_repo", { name: "old" }],
      ["push", { name: "old" }],
      ["commit", { name: "old", message: "x" }],
      ["register_repo", { repo: victimClone, name: "old", branch: "main" }],
    ] as const) {
      const res = await callTool(tools, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.content[0]?.text, tool).toBe(expected);
    }
    for (const tool of ["sync_repo", "open_repo", "push"] as const) {
      const res = await callTool(tools, tool, { name: "oldhost" });
      expect(res.isError, tool).toBe(true);
      expect(res.content[0]?.text, tool).toMatch(/^Refused git source 'http:\/\/127\.0\.0\.1:9\/x\.git': host '127\.0\.0\.1' is a loopback address\./);
    }
    // The lower layer refuses too (routine / working-repo resolution call it directly).
    const ctx = gitRepoContextFor(s.store, s.attacker.id, "old", s.config)!;
    await refusal(ensureGitRepoClone(ctx));
    await refusal(ensureGitRepoClone(ctx, { sync: true }));
    await refusal(pushGitRepo(ctx));
    // Refused, not silently dropped: the registration is still listed and can be removed by its owner.
    expect(s.store.listGitRepos(s.attacker.id).map((repo) => repo.name).sort()).toEqual(["old", "oldhost"]);
    const listed = await callTool(tools, "list_repos", {});
    expect(listed.content[0]?.text).toContain("name=old ");
    const removed = await callTool(tools, "remove_repo", { name: "old" });
    expect(removed.isError).toBeFalsy();
    expect(fs.existsSync(attackerClone)).toBe(false);
  });

  // A redirect is how an allowed external host would hand git a refused address.
  // Needs a non-loopback address of this machine to stand in for that host.
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))?.address;

  it.skipIf(!lanAddress)("does not follow a redirect from a host that is not the configured git host", async () => {
    const s = setup();
    const targetHits: string[] = [];
    const redirectHits: string[] = [];
    const target = http.createServer((req, res) => {
      targetHits.push(req.url ?? "");
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;
    const redirector = http.createServer((req, res) => {
      redirectHits.push(req.url ?? "");
      res.statusCode = 302;
      res.setHeader("Location", `http://127.0.0.1:${targetPort}/meta${req.url}`);
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "0.0.0.0", resolve));
    try {
      const port = (redirector.address() as AddressInfo).port;
      const res = await callTool(s.toolsFor(s.attacker.id, "attacker"), "register_repo", {
        repo: `http://${lanAddress}:${port}/x.git`,
        name: "redir",
      });
      expect(res.isError).toBe(true);
      // git reached the (allowed, private) host, got the 302 and stopped there.
      expect(redirectHits.length).toBeGreaterThan(0);
      expect(targetHits).toEqual([]);
      expect(res.content[0]?.text).toContain("302");
      expect(s.store.getGitRepo(s.attacker.id, "redir")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    }
  });
});

// The plugin clone path takes a USER-named source too (`POST /api/me/plugins`,
// `mcp__system__add_plugin`), and `looksLikeRepo` accepts anything ending in
// `.git`. Before the policy ran here, another user's clone or the team-brain
// vault could be added as a plugin and its files landed in the adder's plugin
// clone; git connected to loopback in every spelling.
describe("plugin sources", () => {
  function bootApp() {
    const dataDir = path.join(tempDir, "data");
    const services = createServices({
      dataDir,
      agentRuntime: "local",
      sessionSecret: "t",
      defaultPluginsDir: path.join(tempDir, "bundled-skills"),
    });
    return { app: createApp(services), store: services.store, config: services.config, dataDir };
  }

  it("refuses a path inside Noah's directories and a blocked host at POST /api/me/plugins, in Korean", async () => {
    const s = bootApp();
    const admin = request.agent(s.app);
    const victim = (await signup(admin, "victim").expect(201)).body.user as { id: string };
    const attackerAgent = request.agent(s.app);
    const attacker = (await signup(attackerAgent, "attacker").expect(201)).body.user as { id: string };
    const victimClone = gitRepoClonePath(victim.id, "secret", s.config);
    gitInit(victimClone, "SECRET.md");
    const vault = path.join(s.dataDir, "team-brain");
    if (!fs.existsSync(path.join(vault, ".git"))) gitInit(vault, "VAULT.md");

    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.headers.host} ${req.url}`);
      res.statusCode = 404;
      res.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const local = "Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다. 사내 git 호스트의 owner/repo 또는 외부에서 접근할 수 있는 git/https 주소를 입력해 주세요.";
      const host = "서버 자신을 가리키는 주소(loopback·link-local·0.0.0.0)는 저장소 주소로 쓸 수 없습니다. 사내 git 호스트의 owner/repo 또는 외부에서 접근할 수 있는 git/https 주소를 입력해 주세요.";
      for (const [repo, message] of [
        [`${victimClone}/.git`, local],
        [`${vault}/.git`, local],
        [`file://${victimClone}/.git`, local],
        [`${path.join(s.config.defaultPluginsDir, "x")}.git`, local],
        [`http://127.0.0.1:${port}/p.git`, host],
        [`http://localhost:${port}/p.git`, host],
        [`http://2130706433:${port}/p.git`, host],
        [`http://[::ffff:127.0.0.1]:${port}/p.git`, host],
        [`http://0.0.0.0:${port}/p.git`, host],
        ["http://169.254.169.254/latest/meta-data/x.git", host],
      ] as const) {
        const res = await attackerAgent.post("/api/me/plugins").send({ repo }).expect(400);
        expect(res.body.error, repo).toBe(message);
        // The answer names no server path and no address.
        expect(res.body.error, repo).not.toContain(s.dataDir);
        expect(fs.existsSync(pluginClonePath(attacker.id, repo, s.config)), repo).toBe(false);
      }
      expect(s.store.listPlugins(attacker.id)).toHaveLength(0);
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Shorthand on the configured host and an ordinary URL are still accepted (nothing is cloned at add time).
    await attackerAgent.post("/api/me/plugins").send({ repo: "owner/repo" }).expect(200);
  });

  it("clones a legitimate local plugin repo outside Noah's directories, and loads the bundled skills without a clone", async () => {
    const s = bootApp();
    const agent = request.agent(s.app);
    const user = (await signup(agent, "plugowner").expect(201)).body.user as { id: string };
    // The bundled default plugin dir is read in place (never through the clone path), so the policy does not touch it.
    makePluginRepo(s.config.defaultPluginsDir, "bundled");
    const remote = makeBareRemote(path.join(tempDir, "outside", "plugin.git"));
    const seed = path.join(tempDir, "outside", "plugin-seed");
    makePluginRepo(seed, "mine");
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    if (!fs.existsSync(path.join(seed, ".git"))) {
      g("init", "-q");
      g("config", "user.email", "t@example.com");
      g("config", "user.name", "T");
      g("add", "-A");
      g("commit", "-q", "-m", "init");
    }
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");

    const added = await agent.post("/api/me/plugins").send({ repo: remote }).expect(200);
    const contents = await agent.get(`/api/me/plugins/${added.body.plugin.id}/contents`).expect(200);
    expect(contents.body.contents).toMatchObject({ kind: "single", plugins: [{ loadable: true }] });
    expect(fs.existsSync(path.join(pluginClonePath(user.id, remote, s.config), ".claude-plugin", "plugin.json"))).toBe(true);
    const { loadDefaultPluginRoots } = await import("../src/server/plugins.js");
    expect((await loadDefaultPluginRoots(s.config)).map((root) => root.path)).toEqual([s.config.defaultPluginsDir]);
  });

  it("never loads a plugin stored BEFORE the policy with a refused source — not even from its cached clone", async () => {
    const s = bootApp();
    const admin = request.agent(s.app);
    const victim = (await signup(admin, "victim").expect(201)).body.user as { id: string };
    const attackerAgent = request.agent(s.app);
    const attacker = (await signup(attackerAgent, "attacker").expect(201)).body.user as { id: string };
    const victimClone = gitRepoClonePath(victim.id, "secret", s.config);
    makePluginRepo(victimClone, "stolen");
    if (!fs.existsSync(path.join(victimClone, ".git"))) {
      const g = (...a: string[]) => execFileSync("git", ["-C", victimClone, ...a], { stdio: "pipe" });
      g("init", "-q");
      g("config", "user.email", "t@example.com");
      g("config", "user.name", "T");
      g("add", "-A");
      g("commit", "-q", "-m", "init");
    }
    // As an older version stored and cloned it (also what mcp__system__add_plugin still stores unchecked).
    const repo = `${victimClone}/.git`;
    const plugin = s.store.addPlugin(attacker.id, { repo });
    const stale = pluginClonePath(attacker.id, repo, s.config);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    execFileSync("git", ["clone", "-q", victimClone, stale], { stdio: "pipe" });
    expect(fs.existsSync(path.join(stale, ".claude-plugin", "plugin.json"))).toBe(true);

    await refusal(syncPluginRepo(attacker.id, plugin, s.config));
    const warnings: string[] = [];
    const roots = await loadAvatarPluginRoots(attacker.id, [plugin], s.config, (message) => warnings.push(message));
    expect(roots).toEqual([]);
    expect(warnings).toEqual([
      `${repo}: 불러오지 않았습니다 — Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다. 사내 git 호스트의 owner/repo 또는 외부에서 접근할 수 있는 git/https 주소를 입력해 주세요.`,
    ]);
    const contents = await attackerAgent.get(`/api/me/plugins/${plugin.id}/contents`).expect(400);
    expect(contents.body.error).toContain("Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다.");
    const refresh = await attackerAgent.post(`/api/me/plugins/${plugin.id}/refresh`).expect(400);
    expect(refresh.body.error).toContain("Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다.");
    // Nothing is deleted behind the user's back: the row stays listed and its owner can remove it (and its clone).
    expect(s.store.listPlugins(attacker.id)).toHaveLength(1);
    await attackerAgent.delete(`/api/me/plugins/${plugin.id}`).expect(200);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
