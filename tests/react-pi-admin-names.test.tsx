/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers src/client/public/pi-admin-names.js: Noah's one addition to pi-gateway's
// admin panel (routes/piAdminProxy.ts adds it to pi's page document). It marks an
// element that SHOWS a Noah user id with the user's name — an attribute only,
// never a change to pi's text or tree. Run here as the browser runs it: the file
// as it is served, evaluated in the page.

const SOURCE = fs.readFileSync(path.join(process.cwd(), "src/client/public/pi-admin-names.js"), "utf8");
const MINSU = "11111111-2222-4333-8444-555555555555";
const YOUNGHEE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const CONSULT = "consult-0123456789abcdef01234567";
/** pi's name for a user's sandbox and workspace folder: `u-` + 24 hex of the id's hash. */
const MINSU_KEY = "u-5e8174f4a95243325ddd12cc";
const USERS = [
  { id: MINSU, key: MINSU_KEY, name: "김민수 (@minsu)" },
  { id: YOUNGHEE, name: "이영희 (@younghee)" },
];

let fetched: string[];
let answer: () => Response;

function run(): void {
  // The script is a plain file the page loads with <script src>: no module, no exports.
  new Function(SOURCE)();
}
/** Past the script's own delay, and the answer of its request. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(200);
}
const marked = () =>
  [...document.querySelectorAll("[data-noah-user]")].map((el) => [el.id, el.getAttribute("data-noah-user")]);

beforeEach(() => {
  vi.useFakeTimers();
  fetched = [];
  answer = () => new Response(JSON.stringify({ users: USERS }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return answer();
    }),
  );
  // A fresh <body> per test: the script of an earlier test keeps watching the body it started on.
  document.body.replaceWith(document.createElement("body"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pi-admin-names.js", () => {
  it("marks the elements that show a known user id — and only marks them", async () => {
    document.body.innerHTML = `
      <table><tbody>
        <tr><td id="cell" class="clip">${MINSU}</td><td id="tokens">1,234</td></tr>
        <tr><td id="stranger">${STRANGER}</td></tr>
        <tr><td id="consult">${CONSULT}</td></tr>
      </tbody></table>
      <p id="line"><span id="who" class="mono">${YOUNGHEE.toUpperCase()}</span> · fake-model · 시작</p>
      <h3 id="heading">${MINSU}</h3>
      <p id="both">${MINSU} → ${YOUNGHEE}</p>
      <table><tbody>
        <tr><td id="sandbox" class="mono">${MINSU_KEY}</td><td id="container" class="mono">pi-sbx-${MINSU_KEY}</td></tr>
        <tr><td id="other-sandbox" class="mono">u-0476d59eff145ce26c4f97ef</td></tr>
      </tbody></table>`;
    const before = document.body.innerHTML;
    run();
    await settle();
    expect(fetched).toEqual(["/api/admin/pi-user-names"]);
    expect(marked()).toEqual([
      ["cell", "김민수 (@minsu)"],
      // The throwaway sandbox of an avatar consultation is nobody's account.
      ["consult", "아바타 상담 (임시 샌드박스)"],
      ["who", "이영희 (@younghee)"],
      ["heading", "김민수 (@minsu)"],
      ["both", "김민수 (@minsu), 이영희 (@younghee)"],
      // The sandbox key of a known user — the key itself, not the container name that contains it.
      ["sandbox", "김민수 (@minsu)"],
    ]);
    // Nothing of pi's was rewritten: the same tree and text, plus the attributes.
    for (const el of document.querySelectorAll("[data-noah-user]")) el.removeAttribute("data-noah-user");
    expect(document.body.innerHTML).toBe(before);
  });

  it("leaves a long text, typed text and preformatted text alone", async () => {
    document.body.innerHTML = `
      <p id="long">${"도구 결과 ".repeat(30)}${MINSU}</p>
      <pre id="pre">${MINSU}</pre>
      <p><code id="code">${MINSU}</code></p>
      <textarea id="typed">${MINSU}</textarea>
      <div id="editable" contenteditable="true">${MINSU}</div>
      <input id="input" value="${MINSU}" />`;
    run();
    await settle();
    expect(marked()).toEqual([]);
  });

  it("follows the page: a row drawn later is marked, a cell reused for something else is unmarked", async () => {
    document.body.innerHTML = `<table><tbody id="rows"><tr><td id="a">${MINSU}</td></tr></tbody></table>`;
    run();
    await settle();
    expect(marked()).toEqual([["a", "김민수 (@minsu)"]]);

    // pi redraws: a new row, and the old cell now shows another user, then no user at all.
    document.getElementById("rows")!.insertAdjacentHTML("beforeend", `<tr><td id="b">${YOUNGHEE}</td></tr>`);
    document.getElementById("a")!.firstChild!.nodeValue = YOUNGHEE;
    await settle();
    expect(marked()).toEqual([
      ["a", "이영희 (@younghee)"],
      ["b", "이영희 (@younghee)"],
    ]);
    document.getElementById("a")!.firstChild!.nodeValue = "-";
    await settle();
    expect(marked()).toEqual([["b", "이영희 (@younghee)"]]);
    // One request for the names, however often the page changed.
    expect(fetched).toHaveLength(1);
  });

  it("asks again when it meets an id nobody was named for — at most once a minute", async () => {
    document.body.innerHTML = `<table><tbody id="rows"><tr><td id="a">${MINSU}</td></tr><tr><td id="new">${STRANGER}</td></tr></tbody></table>`;
    run();
    await settle();
    expect(marked()).toEqual([["a", "김민수 (@minsu)"]]);
    expect(fetched).toHaveLength(1);
    // The page keeps changing: no second request inside the minute.
    document.getElementById("rows")!.insertAdjacentHTML("beforeend", `<tr><td id="b">${YOUNGHEE}</td></tr>`);
    await settle();
    expect(fetched).toHaveLength(1);
    // Someone was approved meanwhile: after the minute, the next change asks again and the row is named.
    answer = () => new Response(JSON.stringify({ users: [...USERS, { id: STRANGER, name: "@newbie 새 사람" }] }), { status: 200 });
    await vi.advanceTimersByTimeAsync(61_000);
    document.getElementById("rows")!.insertAdjacentHTML("beforeend", "<tr><td>x</td></tr>");
    await settle();
    expect(fetched).toHaveLength(2);
    expect(marked()).toEqual([
      ["a", "김민수 (@minsu)"],
      ["new", "@newbie 새 사람"],
      ["b", "이영희 (@younghee)"],
    ]);
  });

  it("puts a name on the page as TEXT, whatever it holds", async () => {
    const hostile = `"><img src=x onerror=alert(1)> ' \\ </td><script>alert(2)</script>`;
    answer = () => new Response(JSON.stringify({ users: [{ id: MINSU, name: hostile }] }), { status: 200 });
    document.body.innerHTML = `<table><tbody><tr><td id="a">${MINSU}</td></tr></tbody></table>`;
    const elements = document.querySelectorAll("*").length;
    run();
    await settle();
    expect(document.getElementById("a")!.getAttribute("data-noah-user")).toBe(hostile);
    expect(document.getElementById("a")!.textContent).toBe(MINSU);
    expect(document.querySelectorAll("*").length).toBe(elements);
    expect(document.querySelector("img, script")).toBeNull();
  });

  it("changes nothing when the names cannot be had", async () => {
    document.body.innerHTML = `<table><tbody><tr><td id="a">${MINSU}</td></tr><tr><td id="c">${CONSULT}</td></tr></tbody></table>`;
    const before = document.body.innerHTML;
    for (const failing of [
      () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      () => new Response("<html>", { status: 200 }),
      () => new Response(JSON.stringify({ users: "nope" }), { status: 200 }),
      () => new Response(JSON.stringify({ users: [{ id: MINSU }, { id: 7, name: "x" }, null] }), { status: 200 }),
    ]) {
      answer = failing;
      run();
      await settle();
      expect(document.body.innerHTML).toBe(before);
    }
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    run();
    await settle();
    expect(document.body.innerHTML).toBe(before);
  });

  it("draws the name before the id, so a cell that clips its text keeps the name", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/client/public/pi-admin-names.css"), "utf8");
    expect(css).toContain("[data-noah-user]::before");
    expect(css).toContain('content: attr(data-noah-user) " · ";');
    // Text only: a name is drawn through attr(), never parsed as markup.
    expect(SOURCE).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  });
});
