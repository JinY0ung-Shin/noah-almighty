#!/usr/bin/env node
// W — Noah's 파일 tab against the real stack (2026-11-13): the listing and the file route read the owner's pi
// sandbox workspace through the workspaces mount, and a pdf / pptx / docx renders to page images with the
// converter of THIS image — the first build that carries libreoffice-writer (a .docx could not load before).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { W, check, client, dind, finish, loadState } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const second = client(state.second.cookie);
const anon = client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userKey = (principal) => `u-${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24)}`;
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const q = (path) => encodeURIComponent(path);

// ---- availability + the listing
const boot = await json(await anon.get("/api/bootstrap"));
check("W  bootstrap says the 파일 tab is available (pi runtime + the workspaces mount)", boot?.workspaceFiles === true);
check("W  the listing needs a session", (await anon.get("/api/me/workspace")).status === 401);
let res = await owner.get("/api/me/workspace");
const rootListing = await json(res);
const rootNames = (rootListing?.entries ?? []).map((e) => e.name);
check("W  the owner's workspace root lists what pi and the earlier turns put there", res.status === 200 && rootListing.exists && rootNames.includes("uploads") && rootNames.includes("c"), rootNames.join(" "));
const uploads = await json(await owner.get(`/api/me/workspace?path=uploads`));
const uploadNames = (uploads?.entries ?? []).map((e) => e.name);
check("W  uploads/ holds the documents attached in the document turns", uploadNames.includes("report.pdf") && uploadNames.includes("notes.md"), uploadNames.join(" "));
const conversations = await json(await owner.get(`/api/me/workspace?path=c`));
const titled = (conversations?.entries ?? []).filter((e) => e.conversation);
check("W  c/ names the owner's conversations by title", titled.length > 0 && titled.every((e) => typeof e.conversation.title === "string"), `${titled.length} of ${(conversations?.entries ?? []).length} entries titled`);

// ---- one file, as a sandboxed download with the bytes pi wrote
res = await owner.get(`/api/me/workspace/file?path=${q("uploads/notes.md")}`);
const notes = Buffer.from(await res.arrayBuffer());
check(
  "W  a file is a sandboxed attachment with the bytes on disk",
  res.status === 200 &&
    res.headers.get("content-type") === "application/octet-stream" &&
    (res.headers.get("content-disposition") ?? "").startsWith("attachment") &&
    (res.headers.get("content-security-policy") ?? "").includes("sandbox") &&
    notes.equals(readFileSync(`${W}/fixtures/notes.md`)),
  `${res.status} ${res.headers.get("content-type")} ${notes.length} bytes`,
);
for (const bad of ["..", "../x", "uploads/../../x", "/etc/passwd"]) {
  check(`W  path ${JSON.stringify(bad)} → 400`, (await owner.get(`/api/me/workspace?path=${q(bad)}`)).status === 400);
}

// ---- document previews with the image's own converter
const ownerWorkspace = `${W}/home/workspaces/${userKey(state.owner.id)}`;
const put = (fixture, name) => {
  // Written as root inside the dind, then handed to the sandbox's owner like every file there.
  dind("sh", "-c", `cp '${W}/fixtures/workspace/${fixture}' '${ownerWorkspace}/uploads/${name}' && chown "$(stat -c %u:%g '${ownerWorkspace}/uploads')" '${ownerWorkspace}/uploads/${name}'`);
};
put("slides.pptx", "w-deck.pptx");
put("memo.docx", "w-memo.docx");
put("slides.pdf", "w-slides.pdf");

async function preview(path, minutes = 4) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < minutes * 60_000) {
    const r = await owner.get(`/api/me/workspace/preview?path=${q(path)}`);
    last = { status: r.status, body: await json(r) };
    if (last.status !== 200 || last.body?.status !== "rendering") break;
    await sleep(2000);
  }
  return { ...last, ms: Date.now() - started };
}
async function pageOf(c, id, n) {
  const r = await c.get(`/api/me/workspace/preview/page?id=${id}&n=${n}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), png: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), bytes: bytes.length, width: bytes.length > 24 ? bytes.readUInt32BE(16) : 0, height: bytes.length > 24 ? bytes.readUInt32BE(20) : 0 };
}
const ids = {};
for (const [path, label, pages] of [
  ["uploads/w-slides.pdf", "a pdf", 3],
  ["uploads/w-deck.pptx", "a pptx (LibreOffice Impress)", 3],
  ["uploads/w-memo.docx", "a docx (LibreOffice Writer — new in this image)", 1],
]) {
  const p = await preview(path);
  ids[path] = p.body?.id;
  check(`W  ${label} renders to ${pages} page image(s)`, p.status === 200 && p.body?.status === "ready" && p.body.pages === pages, `${JSON.stringify(p.body)} in ${p.ms} ms`);
  if (p.body?.status === "ready") {
    const first = await pageOf(owner, p.body.id, 1);
    check(`   its first page is a PNG, long side 1600 px`, first.status === 200 && first.type === "image/png" && first.png && Math.max(first.width, first.height) === 1600, JSON.stringify(first));
    check(`   a page past the end → 404`, (await pageOf(owner, p.body.id, pages + 1)).status === 404);
  }
}
const again = await preview("uploads/w-deck.pptx");
check("W  asking again is the cache (same id, at once)", again.body?.status === "ready" && again.body.id === ids["uploads/w-deck.pptx"] && again.ms < 3000, `${again.ms} ms`);
if (ids["uploads/w-memo.docx"]) {
  check("W  the pages belong to the owner: another user's session gets 404 for the id", (await pageOf(second, ids["uploads/w-memo.docx"], 1)).status === 404);
  check("W  …and so does an anonymous caller (401)", (await anon.get(`/api/me/workspace/preview/page?id=${ids["uploads/w-memo.docx"]}&n=1`)).status === 401);
}
check("W  a file that is not a document → 400", (await owner.get(`/api/me/workspace/preview?path=${q("uploads/notes.md")}`)).status === 400);

// ---- where the conversion ran and what it left
const container = "noah-almighty-noah-almighty-1";
const pkgs = dind("docker", "exec", container, "sh", "-c", "dpkg-query -W -f='${Package} ${Version}\\n' libreoffice-writer libreoffice-impress 2>&1");
check("W  the Noah image carries libreoffice-impress AND libreoffice-writer", /libreoffice-writer \S+/.test(pkgs) && /libreoffice-impress \S+/.test(pkgs), pkgs.trim().replace(/\n/g, "; "));
const cache = dind("docker", "exec", container, "sh", "-c", "cd /app/data/workspace-previews && find . -maxdepth 2 | sort | head -20; echo '--work:'; ls -A .work 2>/dev/null | wc -l");
check("W  the renders are a per-user cache under the data dir, and no private copy is left behind", /\.\/u-[0-9a-f]{24}\/[0-9a-f]{64}/.test(cache) && /--work:\s*0\s*$/.test(cache.trim()), cache.trim().replace(/\n/g, " | ").slice(0, 300));
const sofficeLeft = dind("docker", "exec", container, "sh", "-c", "n=0; for f in /proc/[0-9]*/comm; do c=$(cat $f 2>/dev/null); case \"$c\" in soffice*|oosplash*) n=$((n+1));; esac; done; echo $n");
check("W  no soffice process is left running", sofficeLeft.trim() === "0", sofficeLeft.trim());

finish();
