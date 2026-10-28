# Noah pi sandbox image (deck-capable)

A derived image of pi-gateway's sandbox (`FROM pi-gateway/sandbox:latest`) that lets the bundled `pptx`
skill build decks **inside** a pi sandbox: `bash <skill>/scripts/deck.sh check|build|probe|selftest`
run there under sandboxd's constraints (no network, read-only rootfs, 1 GiB, 1 CPU, 256 pids). It
mirrors the agent-facing deck layers of the main Noah `Dockerfile`
([`docs/architecture/pptx-converter.md`](../../docs/architecture/pptx-converter.md) "Docker packaging")
and follows pi-gateway's rules for derived images (`~/pi-gateway/docs/OPERATIONS.md` §5). Part of the pi
migration, design §6 N8.

| What | Version / where |
|---|---|
| base | `pi-gateway/sandbox:latest` — Debian 13 trixie, Python 3.12.15 (`/usr/local`), Node 22.23.4 |
| Chromium | Debian `chromium-headless-shell` 156.0.8078.47 (`/usr/lib/chromium/chromium-headless-shell`) + `fontconfig` |
| playwright-core | 1.61.1 = `package.json`'s pin, in `/usr/local/lib/node_modules` (+ link in `/usr/local/lib/node`) |
| Python set | `converter/requirements.txt` (python-pptx 1.0.2, lxml 6.1.3, Pillow 12.3.0, …) for CPython 3.12 |
| fonts | the converter's Pretendard ×4, Gothic A1 ×2, Selawik ×2 in `/usr/local/share/fonts/noah-deck` (`60-noah-deck-fonts.conf`, same 맑은 고딕 aliases as the main image) + `fonts-nanum` |
| tools | `poppler-utils` (pdftotext, pdftoppm), uv/uvx 0.8.17, git (base) |
| self-test record | `/usr/local/share/noah-almighty/deck-selftest.json` — the probe's default path |
| env | `NOAH_PPTX_MAX_CONCURRENT=1` (see "Concurrency") — nothing else |

**Not in the image:** the skill tree (Noah supplies it at runtime), LibreOffice (its approximate previews
stay on the Noah side), any secret. Image content 439 MB compressed (base 140 MB), 1.63 GB unpacked.

## Build

From the Noah repository root (the ignore file `Dockerfile.dockerignore` trims the context to the pptx
skill, this directory and the CA file):

```sh
docker build -f docker/pi-sandbox/Dockerfile -t noahpi/sandbox:<tag> .
docker/pi-sandbox/verify.sh --image noahpi/sandbox:<tag>      # optional: --runsc, --keep DIR, --quick
```

Build args (all optional): `SANDBOX_BASE_IMAGE` (default `pi-gateway/sandbox:latest`), `PIP_INDEX_URL` /
`PIP_TRUSTED_HOST` / `NPM_CONFIG_REGISTRY` (mirrors; apt follows the mirror the BASE image was built with),
`CA_CERT_FILE` (build-context path of an extra CA, as in the main image), `UV_VERSION`,
`PLAYWRIGHT_CORE_VERSION`, `DECK_CONVERTER_STRICT_GOLDEN=1` (golden drift fails the build),
`DECK_MAX_CONCURRENT` (default 1). The build runs the converter's self-test from a read-only bind mount
of the skill tree (nothing of it lands in the image) and fails on any integrity failure; on this box it
passed with Chromium 156 with **no golden drift** (`maxDelta 0`).

Rebuild when the base image is rebuilt, when `package.json`'s `playwright-core` pin or
`converter/requirements.txt` changes, or when the converter's fonts change (`tests/pi-sandbox-image.test.ts`
fails on a pin or font mismatch).

## Operator (pi-gateway)

1. Build or load the image on the pi-gateway host, then set it in pi-gateway's `.env`:
   `SANDBOX_IMAGE=noahpi/sandbox:<tag>` and apply it with `docker compose up -d sandboxd`.
2. Running sandboxes keep their old image until removed (OPERATIONS.md §3.5; workspaces survive).
3. Limits: the defaults (`SANDBOX_MEMORY=1g`, 1 CPU, `SANDBOX_PIDS_LIMIT=256`, `/tmp` 256m) are enough
   under **runc** — see "Measured". Under **gVisor** (`SANDBOX_RUNTIME=runsc`) set
   `SANDBOX_PIDS_LIMIT=1024`: the gVisor sentry's own threads count against the host pids cgroup, and a
   build at 256 kills the sandbox (`urpc method "containerManager.WaitPID" failed: EOF`); host peaks of
   340–550 were measured, so 512 is not safe either.
4. No egress rule is needed: the converter never touches the network (it blocks every request itself).

## Measured

`verify.sh` on the dev box (WSL2, Docker 29.1.3, cgroup v2), every scenario in a FRESH container with
sandboxd's flags (`--read-only --cap-drop ALL --security-opt no-new-privileges:true --network none
--tmpfs /tmp:rw,exec,nosuid,nodev,size=256m --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256
--shm-size 64m --ipc private --init -u 1000:1000`, workspace bind-mounted at `/workspace`,
`HOME=/workspace/.home`). Memory and pids are the container cgroup's `memory.peak` / `pids.peak` (memory
includes page cache, which is what the limit counts); `/tmp` is sampled every 250 ms. A dev-box
measurement, not a production sizing — rerun `verify.sh` on the deploy host.

| scenario (runc unless noted) | exit | wall s | memory.peak MiB | pids.peak | `/tmp` peak MiB |
|---|---|---|---|---|---|
| `deck.sh probe --json` (also with `NODE_PATH` unset, and from a read-only `/opt/plugins` mount) | 0 | 0.1 | 22 | 14 | 0 |
| `deck.sh selftest` (2 frozen decks × 2 profiles, 14 slides) | 0 | 33.7 | 395 | 102 | 18.4 |
| `business-review` 4 slides, embedded / malgun, `--strict` | 0 / 0 | 11.3 / 8.1 | 392 / 328 | 104 / 100 | 0.2 |
| `handbook` 4 slides | 0 / 0 | 10.3 / 6.9 | 395 / 329 | 98 / 99 | 0.2 |
| `layouts` 8 slides | 0 / 0 | 17.8 / 14.2 | 396 / 333 | 98 / 99 | 0.2 |
| `talk` 6 slides | 0 / 0 | 13.9 / 10.5 | 417 / 375 | 99 / 101 | 0.2 |
| `visual` 5 slides (photo + captures) | 0 / 0 | 12.6 / 9.2 | 405 / 335 | 98 / 97 | 0.2 |
| `handbook` from a read-only `/opt/plugins` skill mount | 0 | 10.3 | 386 | 99 | 0.2 |
| 60 slides (the cap; `layouts` ×7.5), embedded | 0 | 105.6 | 485 | 101 | 0.2 |
| two builds at once, slots = 1 (the image): `talk`+`visual` / `max60`+`layouts` | 0 | 27.9 / 123.9 | 442 / 512 | 110 / 115 | 0.2 |
| two builds at once, slots = 2 (main image default) | 0 | 29.1 / 126.9 | 757 / 780 | 199 / 199 | 0.5 |
| gVisor `runsc`, `business-review`, `--pids-limit 1024` (host cgroup) | 0 | 58.9 | 440 | 535 | 0.2 |

No scenario was OOM-killed. On one CPU two parallel builds take as long as the same two in sequence
(126.9 s vs 123.9 s), so a single slot costs no throughput.

Conclusions:
- **1 GiB, 256 pids and a 256 MiB `/tmp` are enough** for one conversion of any size up to the 60-slide
  cap. A conversion is one Chromium (~0.3–0.5 GiB peak) and ~100 pids; the converter keeps its run dir
  in `/tmp` but writes renders and the deliverable into the deck folder under `/workspace`, so `/tmp`
  stays small (the self-test, which copies its decks into `/tmp`, is the largest at ~18 MiB).
- **1 CPU stays far inside the 540 s budget:** 7–18 s for the examples, ≈ 106 s at the 60-slide cap.
- **Two at once fit but leave no headroom** (≈ 0.78 GiB, ≈ 200 of 256 pids), hence `NOAH_PPTX_MAX_CONCURRENT=1`.

## Concurrency

The converter's host-wide slots are abstract UNIX sockets, which live in the network namespace. Every pi
sandbox has its own namespace (`network none`), so the slots are **per sandbox = per user**, and the
main image's "2 per host" would become "2 per user". The image therefore sets
`NOAH_PPTX_MAX_CONCURRENT=1`: a user's second simultaneous build waits for the slot (up to
`NOAH_PPTX_SLOT_WAIT_SECONDS`, 150 s) and then exits 5 "busy"; builds of different users run in parallel
in their own sandboxes, bounded by pi-gateway's own sandbox count. `NOAH_PPTX_LOCK_NAMESPACE` is not
needed. Host memory planning = (concurrently active sandboxes) × up to ~0.5 GiB per building sandbox.

## What Noah must do at runtime

1. **Place the skill tree in the sandbox.** Both layouts were verified: a copy at
   `/workspace/.noah/skills/pptx` (read-write, under the user's workspace) and a read-only mount at
   `/opt/plugins/<plugin>/skills/pptx` (the plugin-marketplace layout of design N5). Read-only is the
   converter's intended contract (its KIT is read-only in the main image; `--update-golden` refuses a
   read-only KIT); in `/workspace` the agent can edit its own copy of the converter, which only affects
   that user's sandbox. Copy it without `__pycache__/` and without any `.build/`.
2. **No `deck.sh` change and no env are needed.** The converter resolves `playwright-core` with
   `createRequire` from its own directory; outside an app tree that falls through to Node's global
   folders, where the image puts it (`NODE_PATH=/usr/local/lib/node_modules` from the base image, and the
   built-in `/usr/local/lib/node`, which still works when `NODE_PATH` is dropped — verified). Chromium,
   Python and the self-test record are found at their default paths.
3. **`${CLAUDE_SKILL_DIR}`** (18 uses in `SKILL.md`) is a Claude Code substitution; pi does not perform it.
   Noah must render the skill's real sandbox path into the text it hands the model (or state it in the
   instructions).
4. **The Bash timeout is in SECONDS in pi.** `SKILL.md`/`deck.mjs --help` say "Bash timeout: 600000" (Claude
   Code milliseconds). pi's bash tool takes `timeout` in seconds and sandboxd rejects `timeoutSec` above
   86 400, so a literal 600000 fails validation. Under pi the guidance must read 600 seconds (every run
   ends within its 540 s budget by itself; omitting the timeout also works).
5. **The deck probe must run in the sandbox.** `deckRender.ts` spawns `deck.mjs probe --json` on the Noah
   host; under pi the facts that matter are the sandbox image's. Run `bash <skill>/scripts/deck.sh probe
   --json` through sandboxd (it never starts a browser; ~0.2 s), or pin the result per `SANDBOX_IMAGE`
   tag. The output (same `noah-deck-probe` v1 format the server parser accepts):

   ```json
   {
    "format": "noah-deck-probe",
    "version": 1,
    "converter": true,
    "converterVersion": "1.3.0",
    "chromium": {
     "ok": true,
     "path": "/usr/lib/chromium/chromium-headless-shell",
     "source": "debian-headless-shell",
     "version": "156.0.8078.47"
    },
    "playwrightCore": {
     "ok": true,
     "version": "1.61.1"
    },
    "python": {
     "ok": true,
     "executable": "python3",
     "version": "3.12.15",
     "missingModules": []
    },
    "fonts": {
     "embedded": true,
     "malgun": true
    },
    "profiles": [
     "embedded",
     "malgun"
    ],
    "limits": {
     "maxSlides": 60,
     "maxSeconds": 540,
     "maxSlideHtmlBytes": 2097152,
     "maxDomElements": 2500,
     "maxAssetBytes": 20971520,
     "maxDeckInputBytes": 104857600,
     "maxConcurrent": 1,
     "slotWaitSeconds": 150,
     "maxImagePixels": 40000000,
     "maxSlideImagePixels": 100000000
    },
    "selftest": {
     "status": "pass",
     "chromiumVersion": "156.0.8078.47",
     "at": "2026-10-28T16:32:29Z",
     "maxDelta": 0,
     "differences": 0,
     "lintSetChanged": false,
     "converterVersion": "1.3.0"
    },
    "missing": []
   }
   ```

6. **Decks live under `/workspace`.** The converter writes `.build/`, `<stem>.pptx` and `<stem>.preview/`
   (the hash-bound renders `share_file` attaches) next to the deck; Noah reads them through the host path
   of the workspace mount (design N4), with the same realpath/manifest checks as today.
7. **No LibreOffice in the sandbox:** `scripts/render_deck.sh` (the legacy python-pptx path's renders)
   reports "soffice is not installed"; python-pptx itself is installed. Converter decks never need it, and
   the approximate previews of edited decks stay on the Noah side (design N8).
