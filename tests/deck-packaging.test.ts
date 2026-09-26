// Static packaging contract of the pptx skill's HTML→editable-PPTX converter: the Dockerfile
// layers, the compose build args, the fontconfig registration, the npm and Python pins,
// .env.example, the ignore files, the README maintenance anchors and the Docker smoke script.
// Nothing here builds an image — the real `docker build` and scripts/deck-docker-smoke.sh run at
// release verification (docs/architecture/build-run-verify.md). The "converter tree" block reads
// files that live under default-skills/skills/pptx/converter/ and is green once that tree exists.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const KIT = "default-skills/skills/pptx/converter";
const RECORD = "/usr/local/share/noah-almighty/deck-selftest.json";
const SMOKE = "scripts/deck-docker-smoke.sh";

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

describe("Dockerfile — converter layers", () => {
  const uv = indexOf(/^RUN .*uv --version/);
  const aptConverter = indexOf(/^RUN apt-get update .*chromium-headless-shell/);
  const copyRequirements = dockerfile.indexOf(
    `COPY ${KIT}/requirements.txt /tmp/deck-requirements.txt`,
  );
  const pip = indexOf(/^RUN .*pip3 install .*-r \/tmp\/deck-requirements\.txt/);
  const npmCopy = dockerfile.indexOf("COPY package.json package-lock.json* ./");
  const copyAll = dockerfile.indexOf("COPY . .");
  const npmBuild = dockerfile.indexOf("RUN npm run build");
  const selftest = indexOf(/^RUN .*deck\.mjs selftest/);

  it("is a single-stage build whose runtime user is set only after the self-test", () => {
    expect(dockerfile.filter((i) => /^FROM /.test(i))).toHaveLength(1);
    const users = dockerfile.flatMap((i, n) => (/^USER /.test(i) ? [n] : []));
    expect(users).toEqual([dockerfile.lastIndexOf("USER node")]);
    expect(users[0]).toBeGreaterThan(selftest);
  });

  it("installs fontconfig unconditionally and the headless shell unless DECK_CONVERTER=0, in its own layer after uv", () => {
    expect(uv).toBeGreaterThan(-1);
    expect(aptConverter).toBeGreaterThan(uv);
    const argDeck = dockerfile.indexOf("ARG DECK_CONVERTER=1");
    expect(argDeck).toBeGreaterThan(uv);
    expect(argDeck).toBeLessThan(aptConverter);
    const apt = dockerfile[aptConverter];
    expect(apt).toContain(
      'apt-get install -y --no-install-recommends fontconfig $( [ "$DECK_CONVERTER" != "0" ] && echo chromium-headless-shell )',
    );
    expect(apt).toContain("apt-get clean && rm -rf /var/lib/apt/lists/*");
    expect(apt).toContain("command -v fc-cache");
    expect(apt).toContain(
      '{ [ "$DECK_CONVERTER" = "0" ] || /usr/lib/chromium/chromium-headless-shell --version; }',
    );
    // The full `chromium` package (GTK3/dbus/systemd, ~155 MB more) is never installed.
    expect(dockerfile.join("\n")).not.toMatch(/install[^&;]*\schromium(\s|$)/);
  });

  it("installs the PINNED Python set with pip -r (both mirror branches) and removes the temp copy", () => {
    expect(copyRequirements).toBeGreaterThan(aptConverter);
    expect(pip).toBe(copyRequirements + 1);
    expect(pip).toBeLessThan(npmCopy);
    const run = dockerfile[pip];
    expect(run).toContain(
      'pip3 install --break-system-packages --no-cache-dir --index-url "$PIP_INDEX_URL" ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} -r /tmp/deck-requirements.txt;',
    );
    expect(run).toContain(
      "else pip3 install --break-system-packages --no-cache-dir -r /tmp/deck-requirements.txt;",
    );
    expect(run).toContain("&& rm -f /tmp/deck-requirements.txt");
    // No unpinned package survives next to the requirements file.
    expect(dockerfile.filter((i) => /pip3? install/.test(i))).toEqual([run]);
    expect(run).not.toMatch(/install[^;&]*\bpython-pptx\b/);
    // apt's python3-fonttools drags in ~664 MB of scipy & co.
    expect(dockerfile.join("\n")).not.toContain("python3-fonttools");
  });

  it("self-tests soffice, pdftoppm and every module the skill imports", () => {
    const run = dockerfile[pip];
    expect(run).toContain("&& soffice --version");
    expect(run).toContain("&& command -v pdftoppm");
    expect(run).toContain(
      '&& python3 -c "import pptx, lxml, PIL, fontTools, defusedxml, openpyxl, xlsxwriter"',
    );
  });

  it("registers the fonts and precompiles the converter after COPY . . and npm run build", () => {
    expect(copyAll).toBeGreaterThan(npmCopy);
    expect(npmBuild).toBeGreaterThan(copyAll);
    expect(selftest).toBeGreaterThan(npmBuild);
    const run = dockerfile[selftest];
    expect(run).toMatch(
      /^RUN cp docker\/fontconfig\/60-noah-deck-fonts\.conf \/etc\/fonts\/conf\.d\/ && fc-cache -f >\/dev\/null && fc-list \| grep -q Pretendard /,
    );
    expect(run).toContain(`&& python3 -m compileall -q ${KIT}/tools`);
    expect(run).toContain("&& mkdir -p /usr/local/share/noah-almighty");
  });

  it("runs the self-test in a throwaway TMPDIR/HOME with --record and the strict-golden mapping", () => {
    const argStrict = dockerfile.indexOf("ARG DECK_CONVERTER_STRICT_GOLDEN=0");
    expect(argStrict).toBeGreaterThan(npmBuild);
    expect(argStrict).toBeLessThan(selftest);
    const run = dockerfile[selftest];
    expect(run).toContain('if [ "$DECK_CONVERTER" != "0" ]; then T="$(mktemp -d)";');
    expect(run).toContain(
      `TMPDIR="$T" HOME="$T" node ${KIT}/tools/deck.mjs selftest --record ${RECORD} $( [ "$DECK_CONVERTER_STRICT_GOLDEN" = "1" ] && echo --fail-on-drift ); rc=$?;`,
    );
    // The throwaway dir goes whatever the verdict, THEN the verdict decides the build.
    expect(run).toContain('rc=$?; rm -rf "$T"; [ "$rc" -eq 0 ]; else');
  });

  it("writes a well-formed 'disabled' record when DECK_CONVERTER=0", () => {
    const run = dockerfile[selftest];
    const disabled = run.match(/else printf '(\{[^']*\})\\n' > (\S+); fi/);
    expect(disabled).not.toBeNull();
    expect(disabled?.[2]).toBe(RECORD);
    expect(JSON.parse(disabled?.[1] ?? "null")).toEqual({
      format: "noah-deck-selftest-record",
      version: 1,
      status: "disabled",
    });
  });

  it("fails the build when anything leaked into /tmp", () => {
    expect(dockerfile[selftest]).toMatch(
      /fi && ! ls -A \/tmp \| grep -Eq '\^\(noah-pptx\|playwright\|deck-\)'$/,
    );
  });

  it("sets the image's working directory the fontconfig <dir> is relative to", () => {
    expect(dockerfile.indexOf("WORKDIR /app")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("WORKDIR /app")).toBeLessThan(copyAll);
  });
});

describe("docker-compose.yml", () => {
  it("passes both converter build args (with the Dockerfile defaults) to the app image", () => {
    const compose = read("docker-compose.yml");
    const app = compose.slice(compose.indexOf("  noah-almighty:"), compose.indexOf("    ports:"));
    expect(app).toContain("args:");
    expect(app).toMatch(/^ {8}DECK_CONVERTER: \$\{DECK_CONVERTER:-1\}$/m);
    expect(app).toMatch(/^ {8}DECK_CONVERTER_STRICT_GOLDEN: \$\{DECK_CONVERTER_STRICT_GOLDEN:-0\}$/m);
    // No runtime knob is needed: init reaps Chromium children, Playwright passes
    // --disable-dev-shm-usage, so no shm_size / cap_add for the converter.
    expect(compose.slice(compose.indexOf("  noah-almighty:"), compose.indexOf("  stt:"))).toMatch(
      /^ {4}init: true$/m,
    );
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

  it("documents every converter runtime variable and both build args", () => {
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
      "DECK_CONVERTER",
      "DECK_CONVERTER_STRICT_GOLDEN",
    ]) {
      expect(documented(name), name).toBe(true);
    }
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
      "# DECK_CONVERTER=1",
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

  it("spells out the pre-deck tag and the rollback exactly as rehearsed", () => {
    expect(readme).toContain('IMG="$(docker compose config --images noah-almighty)"');
    expect(readme).toContain('docker image tag "$IMG:latest" "$IMG:pre-deck"');
    expect(readme).toContain(
      'docker image tag "$IMG:pre-deck" "$IMG:latest" && docker compose up -d --no-build noah-almighty',
    );
  });

  it("documents both build args and the update-golden procedure", () => {
    expect(readme).toContain("DECK_CONVERTER=0");
    expect(readme).toContain("DECK_CONVERTER_STRICT_GOLDEN=1");
    expect(readme).toContain("deck.sh selftest --update-golden");
  });
});

describe("scripts/deck-docker-smoke.sh", () => {
  const smoke = read(SMOKE);

  it("parses (bash -n) and is executable", () => {
    execFileSync("bash", ["-n", SMOKE], { cwd: ROOT });
    expect(fs.statSync(path.join(ROOT, SMOKE)).mode & 0o111).not.toBe(0);
  });

  it("answers --help with 0 and an unknown flag with 2, before touching docker", () => {
    const help = spawnSync("bash", [SMOKE, "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(help.status).toBe(0);
    for (const flag of [
      "--image",
      "--build",
      "--baseline-image",
      "--validator-dll",
      "--require-validator",
      "--keep",
    ]) {
      expect(help.stdout).toContain(flag);
    }
    const bad = spawnSync("bash", [SMOKE, "--no-such-flag"], { cwd: ROOT, encoding: "utf8" });
    expect(bad.status).toBe(2);
  });

  it("runs every conversion in one container with the production-hardening flags", () => {
    expect(smoke).toContain(
      "CONV_FLAGS=(--network none --cap-drop ALL --security-opt no-new-privileges:true -u node --init)",
    );
    expect(smoke).toContain('docker run -d --name "$C_SMOKE" "${CONV_FLAGS[@]}" "$IMAGE" sleep infinity');
    const deckCalls = smoke.split("\n").filter((line) => line.includes('bash "$DECK_SH"'));
    expect(deckCalls.length).toBeGreaterThanOrEqual(6);
    for (const line of deckCalls) {
      expect(line).toMatch(/docker exec "\$C_SMOKE" bash "\$DECK_SH" (probe|selftest|build|check) /);
    }
  });

  it("checks what the plan's smoke steps require", () => {
    expect(smoke).toContain(`RECORD=${RECORD}`);
    expect(smoke).toContain("LEAK_RE='^(noah-pptx|playwright|deck-)'");
    expect(smoke).toContain("selftest --fail-on-drift --keep /tmp/w/selftest --json");
    expect(smoke).toContain('--profile "$profile" --strict --json');
    expect(smoke).toContain("grep -q 'already running'");
    expect(smoke).toContain("pkill -KILL -f 'deck[.]mjs'");
    expect(smoke).toContain('"msg":"deck toolchain probe"');
    expect(smoke).toContain("-e SESSION_SECRET=smoke");
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
