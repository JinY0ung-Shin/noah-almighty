#!/usr/bin/env node
// A plugin marketplace served over smart HTTP (git http-backend as CGI), for pi's marketplace refresh checks.
//   GET  /_state                         → { head, versions, fetches: [iso time of every upload-pack POST] }
//   POST /_set {plugin, version, broken} → rewrites that plugin (a new version, or an unreadable plugin.json) and commits
//   /mk/...                              → the repository (git clone http://<ip>:18093/mk)
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const ROOT = "/srv/git";
const REPO = `${ROOT}/mk`;
const PLUGINS = ["alpha", "beta"];
const versions = { alpha: "1.0.0", beta: "1.0.0" };
const fetches = [];
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();

function writePlugin(name, version, broken = false) {
  const dir = `${REPO}/plugins/${name}`;
  mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
  mkdirSync(`${dir}/skills/${name}-skill`, { recursive: true });
  const manifest = JSON.stringify({ name, version, description: `Boot-test plugin ${name}` }, null, 2);
  writeFileSync(`${dir}/.claude-plugin/plugin.json`, broken ? `${manifest.slice(0, -1)} BROKEN` : manifest);
  writeFileSync(
    `${dir}/skills/${name}-skill/SKILL.md`,
    `---\nname: ${name}-skill\ndescription: Boot-test skill of ${name}, marker BOOTMK-${name}-${version}.\n---\n\n# ${name}-skill\n\nBody of ${name} at ${version}.\n`,
  );
}

mkdirSync(`${REPO}/.claude-plugin`, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", REPO]);
git("config", "user.email", "fixture@example.invalid");
git("config", "user.name", "fixture");
writeFileSync(
  `${REPO}/.claude-plugin/marketplace.json`,
  JSON.stringify({ name: "bootmk", owner: { name: "boot test" }, plugins: PLUGINS.map((name) => ({ name, source: `./plugins/${name}`, description: `Boot-test plugin ${name}` })) }, null, 2),
);
for (const name of PLUGINS) writePlugin(name, versions[name]);
git("add", "-A");
git("commit", "-q", "-m", "initial");

function backend(req, res, url) {
  const env = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    GIT_PROJECT_ROOT: ROOT,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_ADDR: req.socket.remoteAddress ?? "",
    ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
    ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
  };
  const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "inherit"] });
  req.pipe(child.stdin);
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    let split = out.indexOf("\r\n\r\n");
    let gap = 4;
    if (split < 0) {
      split = out.indexOf("\n\n");
      gap = 2;
    }
    if (split < 0) {
      res.writeHead(502).end("bad CGI answer");
      return;
    }
    let status = 200;
    const headers = {};
    for (const line of out.subarray(0, split).toString("latin1").split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (key.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
      else headers[key] = value;
    }
    res.writeHead(status, headers).end(out.subarray(split + gap));
  });
}

createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/_state") return json(200, { head: git("rev-parse", "HEAD"), versions, fetches });
  if (url.pathname === "/_set" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const { plugin, version, broken = false } = JSON.parse(raw);
        if (!PLUGINS.includes(plugin) || !/^[0-9.]+$/.test(version)) return json(400, { error: "plugin/version" });
        versions[plugin] = broken ? `${version} (broken)` : version;
        writePlugin(plugin, version, broken);
        git("add", "-A");
        git("commit", "-q", "-m", `${plugin} ${version}${broken ? " broken" : ""}`);
        json(200, { head: git("rev-parse", "HEAD"), versions });
      } catch (error) {
        json(500, { error: String(error) });
      }
    });
    return;
  }
  if (url.pathname.startsWith("/mk/")) {
    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) fetches.push(new Date().toISOString());
    return backend(req, res, url);
  }
  json(404, { error: "not found" });
}).listen(18093, "0.0.0.0", () => console.log("git fixture on :18093"));
