// Static contract of docker/pi-sandbox/ — the deck-capable pi-gateway sandbox image. Nothing here builds
// an image (docker/pi-sandbox/verify.sh drives a built one under sandboxd's constraints); these pins keep
// the derived image in step with the pptx skill and with pi-gateway's derived-image rules
// (~/pi-gateway/docs/OPERATIONS.md §5): same playwright-core pin as package.json, the KIT's pinned Python
// set, every converter font face but the rejected variable one, the probe's default record path, a final
// USER 1000:1000, no setuid/setgid bits, and the pi-sbx helpers left in place.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIR = "docker/pi-sandbox";
const KIT = "default-skills/skills/pptx/converter";
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Logical Dockerfile instructions: comments dropped, `\` continuations joined, whitespace collapsed. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (/\\\s*$/.test(raw)) {
      cur += `${raw.replace(/\\\s*$/, "")} `;
      continue;
    }
    out.push((cur + raw).trim().replace(/\s+/g, " "));
    cur = "";
  }
  return out;
}

const dockerfile = read(`${DIR}/Dockerfile`);
const ins = instructions(dockerfile);

describe("pi sandbox image", () => {
  it("derives from pi-gateway's sandbox and ends unprivileged", () => {
    expect(ins).toContain("ARG SANDBOX_BASE_IMAGE=pi-gateway/sandbox:latest");
    expect(ins).toContain("FROM ${SANDBOX_BASE_IMAGE}");
    const users = ins.filter((i) => i.startsWith("USER "));
    expect(users.at(-1)).toBe("USER 1000:1000");
    expect(ins.at(-1)).toBe('CMD ["/usr/local/bin/sbx-proxy-bridge"]');
    expect(dockerfile).toContain("find / -xdev -perm /6000 -type f -exec chmod a-s {} +");
    // The pi-sbx helpers are only asserted, never copied over or removed.
    for (const helper of ["/usr/local/bin/sbx-run", "/usr/local/bin/sbx-fs", "/usr/local/bin/sbx-proxy-bridge", "/usr/local/lib/pi-sbx"]) {
      for (const i of ins.filter((x) => x.includes(helper) && !x.startsWith("CMD "))) expect(i).toMatch(/^RUN .*test -[xf] /);
    }
    expect(dockerfile).not.toMatch(/^\s*ENV\s+.*(TOKEN|SECRET|PASSWORD|API_KEY)/im);
    // The only ENV is the per-sandbox conversion slot count (proxy env would break derived builds).
    expect(ins.filter((i) => i.startsWith("ENV "))).toEqual(["ENV NOAH_PPTX_MAX_CONCURRENT=${DECK_MAX_CONCURRENT}"]);
    expect(ins).toContain("ARG DECK_MAX_CONCURRENT=1");
  });

  it("pins playwright-core to package.json's version and makes it resolvable from outside an app tree", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(ins).toContain(`ARG PLAYWRIGHT_CORE_VERSION=${pkg.dependencies["playwright-core"]}`);
    expect(dockerfile).toContain("ln -s ../node_modules/playwright-core /usr/local/lib/node/playwright-core");
    expect(dockerfile).toContain("env -u NODE_PATH node -e");
  });

  it("installs the KIT's pinned Python set and the browser/font/pdf toolchain", () => {
    expect(ins).toContain(`COPY ${KIT}/requirements.txt /tmp/deck-requirements.txt`);
    expect(dockerfile).toContain('python3 -c "import pptx, lxml, PIL, fontTools, defusedxml, openpyxl, xlsxwriter"');
    for (const pkg of ["chromium-headless-shell", "fontconfig", "fonts-nanum", "poppler-utils"]) {
      expect(dockerfile).toMatch(new RegExp(`apt-get install[^\\n]*\\n(?:[^\\n]*\\n)*?\\s+${pkg}\\b`));
    }
    expect(dockerfile).toContain("/usr/lib/chromium/chromium-headless-shell --version");
  });

  it("bakes every converter font face except the rejected variable font, where fontconfig looks", () => {
    const kitFaces = fs.readdirSync(path.join(ROOT, KIT, "fonts")).filter((f) => f.endsWith(".ttf") && f !== "NotoSansKR-VF.ttf");
    const copy = ins.find((i) => i.startsWith(`COPY ${KIT}/fonts/`));
    expect(copy).toBeDefined();
    const parts = copy!.split(" ").slice(1);
    const dest = parts.pop()!;
    const copied = parts.map((p) => path.basename(p));
    expect(copied.filter((f) => f.endsWith(".ttf")).sort()).toEqual(kitFaces.sort());
    for (const p of parts) expect(fs.existsSync(path.join(ROOT, p))).toBe(true);
    const conf = read(`${DIR}/60-noah-deck-fonts.conf`);
    expect(conf).toContain(`<dir>${dest.replace(/\/$/, "")}</dir>`);
    expect(ins).toContain(`COPY ${DIR}/60-noah-deck-fonts.conf /etc/fonts/conf.d/`);
    // Same 맑은 고딕 aliases as the main image's registration.
    const main = read("docker/fontconfig/60-noah-deck-fonts.conf");
    for (const alias of main.match(/<alias[^]*?<\/alias>/g) ?? []) expect(conf).toContain(alias);
  });

  it("records the build-time self-test where the probe reads it by default, from a read-only bind mount", () => {
    expect(dockerfile).toContain("--mount=type=bind,source=default-skills/skills/pptx,target=/mnt/noah-pptx-skill");
    expect(dockerfile).toContain("--record /usr/local/share/noah-almighty/deck-selftest.json");
    expect(read(`${KIT}/tools/deck.mjs`)).toContain("/usr/local/share/noah-almighty/deck-selftest.json");
  });

  it("keeps a trimmed build context that still carries everything the Dockerfile reads", () => {
    const ignore = read(`${DIR}/Dockerfile.dockerignore`);
    expect(ignore.split("\n")).toContain("*");
    for (const keep of ["!default-skills/skills/pptx/", "!docker/pi-sandbox/", "!docker/extra-ca.crt.example"]) {
      expect(ignore.split("\n")).toContain(keep);
    }
  });
});
