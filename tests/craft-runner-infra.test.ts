// Static checks on how craft-runner is built and deployed: docker-compose.yml hardening of the runner
// service and the Dockerfile's supply-chain rules (pinned version + sha256, never executing the
// downloaded binary during the build). See craft-runner/README.md › Security model.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const compose = read("docker-compose.yml");
const dockerfile = read("craft-runner/Dockerfile");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const apps: any = await import(pathToFileURL(path.join(REPO, "craft-runner", "src", "apps.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = await import(pathToFileURL(path.join(REPO, "craft-runner", "src", "config.mjs")).href);

/** The text of one top-level service block (2-space indented key) up to the next service / top key. */
function serviceBlock(name: string) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n(?: {2}[a-z][\w-]*:\n|[a-z][\w-]*:)/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}
/** Non-comment lines only, so explanatory comments can never satisfy (or trip) an assertion. */
const code = (block: string) =>
  block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("docker-compose.yml craft-runner service", () => {
  const runner = code(serviceBlock("craft-runner"));
  const noah = code(serviceBlock("noah-almighty"));

  it("has no network, a read-only rootfs and a 0711 tmpfs /tmp", () => {
    expect(runner).toMatch(/^ {4}network_mode: none$/m);
    expect(runner).toMatch(/^ {4}read_only: true$/m);
    expect(runner).toMatch(/^ {6}- \/tmp:size=\d+[kmg]?,mode=0711$/m);
    expect(runner).not.toMatch(/^ {4}(ports|networks|network_mode: (?!none)|extra_hosts|privileged):/m);
  });

  it("drops every capability except the six the daemon needs, with no-new-privileges", () => {
    expect(runner).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
    const add = runner.match(/^ {4}cap_add:\n((?: {6}- [A-Z_]+\n)+)/m);
    expect(add).not.toBeNull();
    const caps = add![1].trim().split("\n").map((l) => l.replace(/^\s*- /, ""));
    expect(caps.sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"]);
    expect(runner).toMatch(/^ {4}security_opt:\n {6}- no-new-privileges:true$/m);
  });

  it("bounds memory, cpu and pids and restarts/reaps like the main service", () => {
    expect(runner).toMatch(/^ {4}mem_limit: 8g$/m);
    expect(runner).toMatch(/^ {4}cpus: 4$/m);
    expect(runner).toMatch(/^ {4}pids_limit: \d+$/m);
    expect(runner).toMatch(/^ {4}init: true$/m);
    expect(runner).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(noah).toMatch(/^ {4}restart: unless-stopped$/m);
  });

  it("mounts ONLY the exchange volume and receives only its three variables (never .env, never the data volume)", () => {
    expect(runner).not.toContain("noah-almighty-data");
    expect(runner).not.toContain("env_file");
    expect(runner).not.toMatch(/docker\.sock/);
    const vols = runner.match(/^ {4}volumes:\n((?: {6}- .+\n)+)/m);
    expect(vols![1].trim().split("\n").map((l) => l.trim())).toEqual(["- craft-exchange:/exchange"]);
    const env = runner.match(/^ {4}environment:\n((?: {6}[A-Z_]+: .+\n)+)/m);
    expect(env![1].trim().split("\n").map((l) => l.trim().split(":")[0])).toEqual(["CRAFT_CONTROL_SECRET", "CRAFT_MAX_PROCS", "CRAFT_EXCHANGE_MAX_BYTES"]);
    expect(runner).toMatch(/^ {6}CRAFT_CONTROL_SECRET: \$\{CRAFT_CONTROL_SECRET:-\}$/m);
    expect(runner).toMatch(/^ {6}CRAFT_MAX_PROCS: 3$/m);
    // The compose default equals the runner's own default (20 GiB).
    const dflt = runner.match(/^ {6}CRAFT_EXCHANGE_MAX_BYTES: \$\{CRAFT_EXCHANGE_MAX_BYTES:-(\d+)\}$/m);
    expect(Number(dflt![1])).toBe(config.DEFAULT_LIMITS.exchangeMaxBytes);
  });

  it("is opt-in (profile) and built from the repo root with the runner Dockerfile", () => {
    expect(runner).toMatch(/^ {4}profiles: \["craft"\]$/m);
    expect(runner).toMatch(/^ {6}context: \.$/m);
    expect(runner).toMatch(/^ {6}dockerfile: craft-runner\/Dockerfile$/m);
  });

  it("gives Noah the exchange volume, its path and the control secret", () => {
    expect(noah).toMatch(/^ {6}- craft-exchange:\/app\/craft-exchange$/m);
    expect(noah).toMatch(/^ {6}CRAFT_EXCHANGE_DIR: \/app\/craft-exchange$/m);
    expect(noah).toMatch(/^ {6}CRAFT_CONTROL_SECRET: \$\{CRAFT_CONTROL_SECRET:-\}$/m);
    expect(compose).toMatch(/\nvolumes:\n {2}noah-almighty-data:\n {2}craft-exchange:\n/);
  });
});

describe("craft-runner/Dockerfile", () => {
  const lines = dockerfile.split("\n");
  // Logical instructions: continuation lines joined, comments dropped.
  const instructions: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (/^\s*#/.test(l) && !cur) continue;
    cur += `${l.replace(/\\$/, "")} `;
    if (!/\\$/.test(l)) {
      if (cur.trim()) instructions.push(cur.trim());
      cur = "";
    }
  }
  const stages: string[][] = [];
  for (const ins of instructions) {
    if (/^FROM /.test(ins)) stages.push([]);
    stages[stages.length - 1]?.push(ins);
  }
  const froms = instructions.filter((i) => /^FROM /.test(i));
  const fetch = stages[0];
  const final = stages[stages.length - 1];

  it("pins PhotoCraft to the registry version and an exact sha256", () => {
    const version = dockerfile.match(/^ARG PHOTOCRAFT_VERSION=(\S+)$/m)?.[1];
    expect(version).toBe(apps.PHOTOCRAFT.version);
    expect(dockerfile).toMatch(/^ARG PHOTOCRAFT_SHA256=[0-9a-f]{64}$/m);
    const run = fetch.find((i) => i.includes("photocraft-${v}-linux-x86_64.tar.gz"))!;
    expect(run).toContain('echo "${PHOTOCRAFT_SHA256}  ${a}" | sha256sum -c -');
    expect(run).toContain('grep -qx "${PHOTOCRAFT_SHA256}  ${a}" SHA256SUMS.txt');
    expect(run).toContain("--no-same-owner");
    expect(run).toMatch(/curl -fsSL --proto '=https'/);
    // the verification precedes extraction
    expect(run.indexOf("sha256sum -c")).toBeLessThan(run.indexOf("tar -xzf"));
  });

  it("never executes the downloaded binary during the build", () => {
    const runs = instructions.filter((i) => /^RUN /.test(i));
    for (const r of runs) {
      expect(r).not.toMatch(/\b(ldd|strace|ltrace|chroot|qemu-\w+)\b/);
      expect(r).not.toMatch(/--version|--help|\bmcp\b/);
      // Every mention of the binary is a pattern/path operand of tar/test/install, never a command.
      for (const m of r.matchAll(/(\S*)(photocraft-cli|"x\/\$\{m\}")/g)) {
        const before = r.slice(Math.max(0, m.index! - 60), m.index!);
        expect(
          /m="photocraft-\$\{v\}-linux-x86_64\/bin\/$/.test(before + m[1]) ||
            /(test -f|test ! -L|install -D -m 0755) $/.test(before) ||
            /install -D -m 0755 "x\/\$\{m\}" \/out\/bin\/$/.test(before + m[1]),
          `unexpected use: …${before}${m[0]}`,
        ).toBe(true);
      }
    }
    // In the final stage nothing runs after the binary arrives.
    const copyAt = final.findIndex((i) => i.startsWith("COPY --from=fetch"));
    expect(copyAt).toBeGreaterThan(-1);
    expect(final.slice(copyAt).some((i) => /^RUN /.test(i))).toBe(false);
  });

  it("ships only the CLI and the runner sources on node:22 with fontconfig + Nanum", () => {
    expect(froms).toEqual(["FROM debian:bookworm-slim AS fetch", "FROM node:22-bookworm-slim"]);
    expect(final).toContain("COPY --from=fetch /out/bin/ /opt/craft/bin/");
    expect(final).toContain("COPY craft-runner/src/ /opt/craft-runner/src/");
    expect(final.filter((i) => /^COPY /.test(i) && !i.includes("apt_mirror_sources.sh"))).toHaveLength(2);
    expect(final.join("\n")).toMatch(/apt-get install -y --no-install-recommends fontconfig fonts-nanum/);
    expect(final).toContain('ENTRYPOINT ["node", "/opt/craft-runner/src/daemon.mjs"]');
    expect(final).toContain("USER root");
  });
});
