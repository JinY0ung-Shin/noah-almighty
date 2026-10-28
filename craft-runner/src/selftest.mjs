// Boot self-test per app (spec §4). Runs in the network-none runner container at every boot (NEVER in
// the image build, which has network). An app is served only when ALL of these hold:
//   - initialize + tools/list succeed and the served tool set equals the registry's `expectedTools`
//     (a version bump that changes tools fails closed until the deny list is re-verified);
//   - opening a probe image INSIDE the read root succeeds (positive control), and
//   - opening the same image OUTSIDE the read root — by absolute path and by `../` — is rejected,
//     although the file is readable by the test uid (so the rejection is the app's confinement).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { AppProcess, buildChildEnv } from "./appProcess.mjs";
import { removeTreeAt } from "./fsx.mjs";
import { filterTools } from "./policy.mjs";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid w×h RGB PNG filled with one colour. */
export function solidPng(w, h, [r, g, b] = [200, 60, 40]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function mkdirOwned(p, owner, mode) {
  fs.mkdirSync(p, { mode });
  if (owner) fs.chownSync(p, owner.uid, owner.gid);
  fs.chmodSync(p, mode);
}

function writeOwned(p, data, owner, mode) {
  fs.writeFileSync(p, data, { mode, flag: "wx" });
  if (owner) fs.chownSync(p, owner.uid, owner.gid);
  fs.chmodSync(p, mode);
}

const resultText = (r) =>
  (r?.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .slice(0, 300);

const isRejected = (r) => !!r.error || r.result?.isError === true;

/** Longest self-test error text the runner reports (it reaches Noah's prompt surfaces). */
export const MAX_REPORTED_ERROR = 300;

/**
 * Sanitize text the runner reports about an app (Addendum A5): control characters (C0, DEL, C1) become
 * spaces, whitespace runs collapse, and the result is cut to 300 characters (on a code-point boundary).
 * @param {unknown} text
 */
export function sanitizeReportedError(text) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const cps = Array.from(flat);
  return cps.length <= MAX_REPORTED_ERROR ? flat : `${cps.slice(0, MAX_REPORTED_ERROR - 1).join("")}…`;
}

/**
 * @param {object} app
 * @param {object} o
 * @param {string} o.tmpRoot   root-owned 0711 directory for the test tree
 * @param {{uid:number,gid:number}|null} o.ids   uid to run the app as (null = daemon uid, tests)
 * @param {(kind: string, uid?: number) => ({uid:number,gid:number}|null)} o.owner
 * @param {object} o.limits
 * @param {(m: string) => void} [o.log]
 * @returns {Promise<{status: "ready", manifest: object} | {status: "failed", error: string}>}
 */
export async function selfTestApp(app, o) {
  const name = `.selftest-${app.id}-${crypto.randomBytes(6).toString("hex")}`;
  const base = path.join(o.tmpRoot, name);
  const testOwner = o.ids ? o.owner("session", o.ids.uid) : o.owner("session", undefined);
  const rootOwner = o.owner("root");
  let proc;
  try {
    mkdirOwned(base, rootOwner, 0o711);
    const readRoot = path.join(base, "root");
    mkdirOwned(readRoot, testOwner, 0o700);
    mkdirOwned(path.join(readRoot, "in"), rootOwner, 0o755);
    mkdirOwned(path.join(readRoot, "out"), testOwner, 0o700);
    mkdirOwned(path.join(base, "outside"), testOwner, 0o700);
    mkdirOwned(path.join(base, "home"), testOwner, 0o700);
    mkdirOwned(path.join(base, "tmp"), testOwner, 0o700);
    const png = solidPng(8, 8);
    writeOwned(path.join(readRoot, "in", "probe.png"), png, rootOwner, 0o644);
    writeOwned(path.join(base, "outside", "probe.png"), png, testOwner, 0o600);

    proc = new AppProcess({
      app,
      readRoot,
      writeRoot: path.join(readRoot, "out"),
      cwd: readRoot,
      env: buildChildEnv({ home: path.join(base, "home"), tmpDir: path.join(base, "tmp") }, app.env),
      ids: o.ids,
      limits: o.limits,
      log: o.log,
    });
    const init = await proc.start();
    if (init.serverInfo?.version !== app.version) {
      throw new Error(`binary reports version ${init.serverInfo?.version ?? "?"}, registry pins ${app.version}`);
    }
    const listed = await proc.request("tools/list", {}, o.limits.initTimeoutMs);
    const tools = listed.result?.tools;
    if (!Array.isArray(tools)) throw new Error("tools/list returned no tool array");
    const served = filterTools(tools, app.deniedTools);
    const names = new Set(served.map((t) => t.name));
    const expected = new Set(app.expectedTools);
    const added = [...names].filter((n) => !expected.has(n)).sort();
    const removed = [...expected].filter((n) => !names.has(n)).sort();
    if (added.length || removed.length) {
      throw new Error(
        `tool list drifted from apps.mjs (added: ${added.join(",") || "-"}; missing: ${removed.join(",") || "-"}); re-verify the deny list and update expectedTools`,
      );
    }
    const call = (args) =>
      proc.request("tools/call", { name: app.selfTest.openTool, arguments: args }, o.limits.callTimeoutMs);
    const inside = await call(app.selfTest.openArgs(path.join(readRoot, "in", "probe.png")));
    if (isRejected(inside)) {
      throw new Error(`positive control failed: ${app.selfTest.openTool} inside the read root was refused (${resultText(inside)})`);
    }
    for (const outside of [path.join(base, "outside", "probe.png"), "../outside/probe.png"]) {
      const r = await call(app.selfTest.openArgs(outside));
      if (!isRejected(r)) {
        throw new Error(`confinement failed: ${app.selfTest.openTool} opened ${outside} outside the read root`);
      }
    }
    return {
      status: "ready",
      manifest: {
        protocolVersion: init.protocolVersion,
        serverInfo: init.serverInfo,
        instructions: typeof init.instructions === "string" ? init.instructions : "",
        tools: served,
      },
    };
  } catch (err) {
    const stderr = proc?.stderrTail ? ` [stderr: ${proc.stderrTail.slice(-200)}]` : "";
    return { status: "failed", error: sanitizeReportedError(`self-test failed: ${err.message}${stderr}`) };
  } finally {
    if (proc) {
      proc.kill("self-test done");
      await proc.waitExit();
    }
    try {
      removeTreeAt(o.tmpRoot, name);
    } catch {
      /* tmpfs; best effort */
    }
  }
}
