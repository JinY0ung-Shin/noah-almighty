// Static packaging contract of the pptx skill's HTML→editable-PPTX converter: what the Noah
// Dockerfile keeps (fonts for LibreOffice previews) and no longer carries (decks build in the pi
// sandbox image, docker/pi-sandbox), the compose wiring of that image, the fontconfig
// registration, the npm and Python pins, .env.example, the ignore files, the README maintenance
// anchors and the sandbox image check (docker/pi-sandbox/verify.sh).
// Nothing here builds an image — the real `docker build` and docker/pi-sandbox/verify.sh run at
// release verification (docs/architecture/build-run-verify.md). The "converter tree" block reads
// files that live under default-skills/skills/pptx/converter/ and is green once that tree exists.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const KIT = "default-skills/skills/pptx/converter";
const RECORD = "/usr/local/share/noah-almighty/deck-selftest.json";

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Dockerfile → logical instructions, the way BuildKit reads them: comment lines are dropped even
 * inside a continued RUN (the hex-ssh layer has some), `\` continuations are joined, and runs of
 * whitespace collapse to one space so the assertions below can pin shell text exactly.
 */
function dockerInstructions(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;
    if (!line.trim()) continue;
    if (/\\\s*$/.test(line)) {
      current += `${line.replace(/\\\s*$/, "")} `;
      continue;
    }
    current += line;
    out.push(current.trim().replace(/\s+/g, " "));
    current = "";
  }
  if (current.trim()) out.push(current.trim().replace(/\s+/g, " "));
  return out;
}

const dockerfile = dockerInstructions(read("Dockerfile"));
const indexOf = (re: RegExp): number => dockerfile.findIndex((instruction) => re.test(instruction));

describe("Dockerfile — the Noah image carries no deck converter", () => {
  // Decks build inside the user's pi sandbox (docker/pi-sandbox, pinned by
  // tests/pi-sandbox-image.test.ts). The Noah image keeps only what the SERVER runs:
  // LibreOffice + poppler for share_file's approximate previews and the fonts they use.
  const baseApt = indexOf(/^RUN .*apt-get install -y --no-install-recommends build-essential /);
  const npmCopy = dockerfile.indexOf("COPY package.json package-lock.json* ./");
  const npmInstall = indexOf(/^RUN .*npm install;/);
  const copyFontconf = dockerfile.indexOf("COPY docker/fontconfig/60-noah-deck-fonts.conf /etc/fonts/conf.d/");
  const copyPptx = dockerfile.indexOf("COPY default-skills/skills/pptx ./default-skills/skills/pptx");
  // The app COPY leaves out the pptx tree: the font layer already put it in place.
  const copyAll = dockerfile.indexOf("COPY --exclude=default-skills/skills/pptx . .");
  const npmBuild = dockerfile.indexOf("RUN npm run build");
  const fonts = indexOf(/^RUN fc-cache /);

  it("is a single-stage build whose runtime user is set only after every build step", () => {
    expect(dockerfile.filter((i) => /^FROM /.test(i))).toHaveLength(1);
    const users = dockerfile.flatMap((i, n) => (/^USER /.test(i) ? [n] : []));
    expect(users).toEqual([dockerfile.lastIndexOf("USER node")]);
    expect(users[0]).toBeGreaterThan(npmBuild);
  });

  it("installs no Chromium, no pip set, no uv and runs no converter self-test", () => {
    const text = dockerfile.join("\n");
    expect(text).not.toMatch(/chromium/i);
    expect(text).not.toMatch(/pip3? install|python3-pip|requirements\.txt/);
    expect(text).not.toMatch(/\buvx?\b/);
    expect(text).not.toMatch(/deck\.mjs|selftest|DECK_CONVERTER/);
    // The agent shell's tools moved to the sandbox image with the agent.
    expect(text).not.toMatch(/\b(ripgrep|jq|procps)\b/);
  });

  it("installs what the server itself runs and checks it in the same layer", () => {
    expect(baseApt).toBeGreaterThan(-1);
    const apt = dockerfile[baseApt];
    for (const pkg of [
      "fontconfig",
      "fonts-nanum",
      "git",
      "gh",
      "libreoffice-impress",
      "poppler-utils",
      "python3",
      "python3-cryptography",
      "python3-paramiko",
      "tini",
    ]) {
      expect(apt, pkg).toMatch(new RegExp(` ${escapeRe(pkg)} `));
    }
    expect(apt).toContain("&& soffice --version");
    expect(apt).toContain("&& command -v pdftoppm fc-cache");
    expect(apt).toContain('&& python3 -c "import cryptography, paramiko"');
    // Downloads ride a BuildKit cache mount; docker-clean is parked for the RUN and restored, so
    // images built FROM this one keep stock apt behaviour.
    expect(apt).toMatch(
      /^RUN --mount=type=cache,target=\/var\/cache\/apt,sharing=locked --mount=type=cache,target=\/var\/lib\/apt\/lists,sharing=locked mv \/etc\/apt\/apt\.conf\.d\/docker-clean \/etc\/apt\/docker-clean\.parked /,
    );
    expect(apt).toContain("&& mv /etc/apt/docker-clean.parked /etc/apt/apt.conf.d/docker-clean");
  });

  it("registers the deck fonts after npm install but BEFORE the app COPY", () => {
    // Its inputs are the pptx skill tree and the fontconfig file only, so a code-only rebuild
    // reuses the layer.
    expect(npmInstall).toBe(npmCopy + 1);
    expect(copyFontconf).toBeGreaterThan(npmInstall);
    expect(copyPptx).toBe(copyFontconf + 1);
    expect(fonts).toBe(copyPptx + 1);
    expect(dockerfile[fonts]).toBe("RUN fc-cache -f >/dev/null && fc-list | grep -q Pretendard");
    expect(copyAll).toBe(fonts + 1);
    expect(npmBuild).toBe(copyAll + 1);
    // Exactly one app COPY, and it is the excluding one.
    expect(dockerfile.filter((i) => /^COPY (--\S+ )*\. \.$/.test(i))).toEqual([dockerfile[copyAll]]);
  });

  it("sets the image's working directory the fontconfig <dir> is relative to", () => {
    expect(dockerfile.indexOf("WORKDIR /app")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("WORKDIR /app")).toBeLessThan(copyPptx);
  });
});

describe("docker-compose.yml", () => {
  const compose = read("docker-compose.yml");
  const service = (name: string): string => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const end = rest.slice(1).search(/\n(  [a-z][\w-]*:|[a-z][\w-]*:)\n/);
    return end < 0 ? rest : rest.slice(0, end + 2);
  };

  it("builds the deck-capable sandbox image FROM pi's own sandbox build, strict-golden mapped", () => {
    const sbx = service("pi-sandbox-image");
    expect(sbx).toContain("image: noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG:-latest}");
    expect(sbx).toContain("dockerfile: docker/pi-sandbox/Dockerfile");
    expect(sbx).toMatch(/^ {8}pi-sandbox-base: service:sandbox-image$/m);
    expect(sbx).toMatch(/^ {8}SANDBOX_BASE_IMAGE: pi-sandbox-base$/m);
    expect(sbx).toMatch(/^ {8}DECK_CONVERTER_STRICT_GOLDEN: \$\{DECK_CONVERTER_STRICT_GOLDEN:-0\}$/m);
    expect(sbx).toMatch(/^ {4}network_mode: none$/m);
    // pi's sandboxd runs exactly that image.
    expect(read("docker/pi/compose.override.yml")).toContain(
      "SANDBOX_IMAGE: noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG:-latest}",
    );
  });

  it("keeps the Noah service free of converter knobs, with compose init off (#71)", () => {
    const app = service("noah-almighty");
    expect(compose).not.toMatch(/DECK_CONVERTER:/);
    expect(app).toMatch(/^ {4}init: false$/m);
    expect(app).not.toMatch(/shm_size|cap_add/);
  });
});

describe("docker/fontconfig/60-noah-deck-fonts.conf", () => {
  const conf = read("docker/fontconfig/60-noah-deck-fonts.conf");

  it("registers exactly the image path of the converter's fonts directory", () => {
    const dirs = [...conf.matchAll(/<dir>([^<]+)<\/dir>/g)].map((m) => m[1]);
    expect(dirs).toEqual([`/app/${KIT}/fonts`]);
  });

  it("rejects the NotoSansKR variable font (LibreOffice draws its Thin default instance)", () => {
    const rejected = [...conf.matchAll(/<rejectfont>\s*<glob>([^<]+)<\/glob>\s*<\/rejectfont>/g)].map(
      (m) => m[1],
    );
    expect(rejected).toEqual([`/app/${KIT}/fonts/NotoSansKR-VF.ttf`]);
  });

  it("aliases both 맑은 고딕 spellings to Selawik, then Gothic A1", () => {
    for (const family of ["맑은 고딕", "Malgun Gothic"]) {
      expect(conf).toContain(
        `<alias binding="same"><family>${family}</family><prefer><family>Selawik</family><family>Gothic A1</family></prefer></alias>`,
      );
    }
    expect([...conf.matchAll(/<alias /g)]).toHaveLength(2);
  });

  it("is a single <fontconfig> document with valid XML comments", () => {
    expect(conf.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect([...conf.matchAll(/<fontconfig>/g)]).toHaveLength(1);
    expect(conf.trimEnd().endsWith("</fontconfig>")).toBe(true);
    for (const comment of conf.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(comment[1]).not.toContain("--");
    }
  });
});

describe("npm: playwright-core is a pinned RUNTIME dependency", () => {
  it("is pinned exactly in dependencies", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["playwright-core"]).toBe("1.61.1");
    expect(pkg.devDependencies["playwright-core"]).toBeUndefined();
  });

  it("resolves to ONE non-dev lock entry that @playwright/test shares (image delta 0)", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string> }>;
    };
    expect(lock.packages[""]?.dependencies?.["playwright-core"]).toBe("1.61.1");
    const entries = Object.entries(lock.packages)
      .filter(([key]) => /(^|\/)node_modules\/playwright-core$/.test(key))
      .map(([key, entry]) => [key, entry.version, entry.dev === true]);
    expect(entries).toEqual([["node_modules/playwright-core", "1.61.1", false]]);
    expect(lock.packages["node_modules/playwright"]?.dependencies?.["playwright-core"]).toBe(
      "1.61.1",
    );
  });
});

describe(".env.example", () => {
  const env = read(".env.example");
  const documented = (name: string): boolean => new RegExp(`^#?\\s*${name}=`, "m").test(env);

  it("documents every converter runtime variable and the strict-golden build arg", () => {
    for (const name of [
      "NOAH_PPTX_CHROMIUM",
      "NOAH_PPTX_DEV",
      "NOAH_PPTX_PYTHON",
      "NOAH_PPTX_MAX_CONCURRENT",
      "NOAH_PPTX_SLOT_WAIT_SECONDS",
      "NOAH_PPTX_MAX_SECONDS",
      "NOAH_PPTX_MAX_SLIDES",
      "NOAH_PPTX_LOCK_NAMESPACE",
      "NOAH_PPTX_SELFTEST_RECORD",
      "DECK_CONVERTER_STRICT_GOLDEN",
    ]) {
      expect(documented(name), name).toBe(true);
    }
    // The Noah image has no converter any more, so no DECK_CONVERTER switch.
    expect(documented("DECK_CONVERTER")).toBe(false);
    // A tests-only switch has no place in a deployment env file.
    expect(documented("NOAH_PPTX_E2E")).toBe(false);
  });

  it("states the defaults the converter and the Dockerfile use", () => {
    for (const line of [
      "# NOAH_PPTX_MAX_CONCURRENT=2",
      "# NOAH_PPTX_SLOT_WAIT_SECONDS=150",
      "# NOAH_PPTX_MAX_SECONDS=540",
      "# NOAH_PPTX_MAX_SLIDES=60",
      `# NOAH_PPTX_SELFTEST_RECORD=${RECORD}`,
      "# DECK_CONVERTER_STRICT_GOLDEN=0",
    ]) {
      expect(env).toMatch(new RegExp(`^${escapeRe(line)}$`, "m"));
    }
  });

  it("warns that DEFAULT_PLUGINS_DIR must stay inside the app tree", () => {
    const block = env.slice(0, env.indexOf("# DEFAULT_PLUGINS_DIR="));
    expect(block.slice(block.lastIndexOf("\n\n"))).toMatch(/INSIDE the app tree/);
  });
});

describe("ignore files", () => {
  it("keep Python bytecode and converter .build/ dirs out of git and the build context", () => {
    for (const file of [".gitignore", ".dockerignore"]) {
      const rules = read(file)
        .split("\n")
        .map((line) => line.trim());
      for (const rule of [
        "**/__pycache__/",
        "**/*.pyc",
        "**/.build/",
        "scripts/openxml-validator/bin/",
        "scripts/openxml-validator/obj/",
      ]) {
        expect(rules, `${file}: ${rule}`).toContain(rule);
      }
    }
  });

  it("exclude nothing an egress Dockerfile copies", () => {
    const egress = fs
      .readdirSync(path.join(ROOT, "docker/egress"))
      .filter((name) => name.endsWith(".Dockerfile"));
    expect(egress.length).toBeGreaterThan(0);
    for (const name of egress) {
      const copies = dockerInstructions(read(`docker/egress/${name}`)).filter(
        (i) => /^(COPY|ADD) /.test(i) && /__pycache__|\.pyc\b|\/\.build\b/.test(i),
      );
      expect(copies, name).toEqual([]);
    }
  });
});

describe("README maintenance anchors", () => {
  const readme = read("README.md");
  // GitHub's heading slug: lower-case, punctuation dropped, spaces → hyphens.
  const slug = (heading: string): string =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s/g, "-");
  const anchors = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));

  it("has the golden-drift and rollback sections the build log and the probe point at", () => {
    expect(anchors.has("deck-converter-golden-drift")).toBe(true);
    expect(anchors.has("deck-converter-rollback")).toBe(true);
  });

  it("spells out the pre-upgrade tags of both images and the rollback", () => {
    expect(readme).toContain('NOAH_IMG="$(docker compose config --images noah-almighty)"');
    expect(readme).toContain('docker image tag "$NOAH_IMG:latest" "$NOAH_IMG:pre-upgrade"');
    expect(readme).toContain("docker image tag noah-almighty/pi-sandbox:latest noah-almighty/pi-sandbox:pre-upgrade");
    expect(readme).toContain('docker image tag "$NOAH_IMG:pre-upgrade" "$NOAH_IMG:latest"');
    expect(readme).toContain("docker image tag noah-almighty/pi-sandbox:pre-upgrade noah-almighty/pi-sandbox:latest");
    // A sandbox keeps its image until it is recreated.
    expect(readme).toContain("docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)");
  });

  it("documents the strict-golden build arg and the update-golden procedure", () => {
    expect(readme).toContain("DECK_CONVERTER_STRICT_GOLDEN=1");
    expect(readme).toContain("deck.sh selftest --update-golden");
    expect(readme).not.toContain("DECK_CONVERTER=0");
  });
});

describe("docker/pi-sandbox/verify.sh (the deck image check)", () => {
  const VERIFY = "docker/pi-sandbox/verify.sh";
  it("parses, is executable, and runs every conversion under sandboxd's flags", () => {
    execFileSync("bash", ["-n", VERIFY], { cwd: ROOT });
    expect(fs.statSync(path.join(ROOT, VERIFY)).mode & 0o111).not.toBe(0);
    const verify = read(VERIFY);
    expect(verify).toContain("--read-only --cap-drop ALL --security-opt no-new-privileges:true --network none");
    expect(verify).toContain("--init --user 1000:1000");
  });

  it("replaces the retired Noah-image smoke (no converter in the Noah image any more)", () => {
    expect(fs.existsSync(path.join(ROOT, "scripts/deck-docker-smoke.sh"))).toBe(false);
    expect(read(".dockerignore")).not.toContain("deck-docker-smoke");
  });
});

describe("scripts/openxml-validator (dev/CI-only source)", () => {
  it("pins Open XML SDK 3.3.0 on .NET 8 and validates against Microsoft365", () => {
    expect(read("scripts/openxml-validator/Validator.csproj")).toContain(
      '<PackageReference Include="DocumentFormat.OpenXml" Version="3.3.0" />',
    );
    expect(read("scripts/openxml-validator/Validator.csproj")).toContain(
      "<TargetFramework>net8.0</TargetFramework>",
    );
    expect(read("scripts/openxml-validator/Program.cs")).toContain(
      "new OpenXmlValidator(FileFormatVersions.Microsoft365)",
    );
  });
});

describe("docs/architecture/pptx-converter.md", () => {
  it("carries the generated --help block markers once each, in order, and is indexed", () => {
    const page = read("docs/architecture/pptx-converter.md");
    const begin = page.split("<!-- deck-help:begin -->").length - 1;
    const end = page.split("<!-- deck-help:end -->").length - 1;
    expect([begin, end]).toEqual([1, 1]);
    expect(page.indexOf("<!-- deck-help:begin -->")).toBeLessThan(
      page.indexOf("<!-- deck-help:end -->"),
    );
    expect(read("docs/ARCHITECTURE-NOTES.md")).toContain("(architecture/pptx-converter.md)");
  });
});

// The files below are produced by the converter port (default-skills/skills/pptx/converter/**);
// they pin what the image build above consumes.
describe("converter tree the image build consumes", () => {
  it("pins requirements.txt to exactly the verified Python set (name==version lines)", () => {
    const verified = [
      "python-pptx==1.0.2",
      "lxml==6.1.3",
      "Pillow==12.3.0",
      "XlsxWriter==3.2.9",
      "typing_extensions==4.16.0",
      "fonttools==4.66.0",
      "defusedxml==0.7.1",
      "openpyxl==3.1.5",
      "et_xmlfile==2.0.0",
    ];
    // PEP 503 name normalization, so a cosmetic spelling (pillow vs Pillow) is not a failure.
    const normalize = (line: string): string => {
      const [name, version] = line.split("==");
      return `${name.toLowerCase().replace(/[-_.]+/g, "-")}==${version}`;
    };
    const lines = read(`${KIT}/requirements.txt`)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      expect(line).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.]*$/);
    }
    expect(lines.map(normalize).sort()).toEqual(verified.map(normalize).sort());
    // PoC-only QA packages never ship.
    expect(lines.join("\n")).not.toMatch(/^(numpy|uharfbuzz)==/im);
  });

  it("ships the fonts the fontconfig conf registers, rejects and aliases", () => {
    const fonts = fs.readdirSync(path.join(ROOT, KIT, "fonts"));
    expect(fonts).toContain("NotoSansKR-VF.ttf");
    expect(fonts.some((name) => /^Pretendard-.*\.ttf$/.test(name))).toBe(true);
    expect(fonts.some((name) => /^GothicA1-.*\.ttf$/.test(name))).toBe(true);
    expect(fonts.some((name) => /^selawk.*\.ttf$/i.test(name))).toBe(true);
  });

  it("has the self-test entry point the Dockerfile runs", () => {
    expect(fs.statSync(path.join(ROOT, KIT, "tools/deck.mjs")).isFile()).toBe(true);
    expect(fs.statSync(path.join(ROOT, KIT, "tools")).isDirectory()).toBe(true);
  });
});
