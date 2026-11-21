// A tiny browser stand-in for the login check: one cookie jar per "browser" (Path-aware, one host), manual redirects.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
export const ORIGIN = "https://noah.rig.test";
export class Browser {
  jar = new Map(); // name → { value, path }
  cookieHeader(pathname) {
    return [...this.jar].filter(([, c]) => pathname.startsWith(c.path)).map(([n, c]) => `${n}=${c.value}`).join("; ");
  }
  store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      const path = (attrs.find((a) => /^path=/i.test(a)) ?? "Path=/").slice(5);
      const gone = /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line) || value === "";
      if (gone) this.jar.delete(name); else this.jar.set(name, { value, path });
    }
  }
  async req(url, { method = "GET", form, json } = {}) {
    const u = new URL(url, ORIGIN);
    const headers = { cookie: this.cookieHeader(u.pathname), origin: ORIGIN };
    let body;
    if (form) { body = new URLSearchParams(form); }
    if (json !== undefined) { body = JSON.stringify(json); headers["content-type"] = "application/json"; }
    const res = await fetch(u, { method, headers, body, redirect: "manual" });
    this.store(res);
    return res;
  }
  /** Follow redirects (GET) until a page or JSON; returns { res, url, text }. */
  async go(url, opts) {
    let res = await this.req(url, opts), at = new URL(url, ORIGIN).toString();
    for (let i = 0; i < 12 && res.status >= 300 && res.status < 400; i++) {
      at = new URL(res.headers.get("location"), at).toString();
      res = await this.req(at);
    }
    return { res, url: at, text: await res.text() };
  }
  /** Fill Keycloak's login (or registration) form on `page` and follow back to Noah. */
  async submitKeycloakForm(page, fields) {
    const action = (page.text.match(/<form[^>]*action="([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, "&");
    if (!action) throw new Error("no form on " + page.url + " :: " + page.text.slice(0, 160).replace(/\s+/g, " "));
    return this.go(action, { method: "POST", form: fields });
  }
  async json(url, opts) {
    const res = await this.req(url, opts);
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text.slice(0, 200) }; }
  }
}
export const kcError = (text) => (text.match(/kc-feedback-text[^>]*>\s*([^<]+)/) ?? [])[1]?.trim() ?? null;
let n = 0, failed = 0;
export function check(label, ok, detail = "") {
  n += 1; if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${String(n).padStart(2)} ${label}${detail ? " — " + detail : ""}`);
}
export const summary = () => { console.log(`\n${n - failed}/${n} passed`); if (failed) process.exit(1); };
// Keycloak's admin API as Noah's service account, for looking at what Noah wrote.
export async function keycloakAdmin(secret) {
  const base = "http://keycloak:8080/sso";
  const tok = await (await fetch(base + "/realms/noah/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "noah", client_secret: secret, scope: "kc-admin-api" }) })).json();
  const H = { authorization: "Bearer " + tok.access_token };
  const get = async (p) => (await fetch(base + "/admin/realms/noah" + p, { headers: H })).json();
  const group = (await get("/groups?search=teammates&exact=true"))[0];
  return {
    user: (id) => fetch(base + "/admin/realms/noah/users/" + id, { headers: H }).then((r) => (r.status === 200 ? r.json() : null)),
    teammates: async () => (await get(`/groups/${group.id}/members?max=500`)).map((u) => u.username).sort(),
    admins: async () => (await get(`/roles/admin/users?max=500`)).map((u) => u.username).sort(),
    realm: () => get(""),
  };
}
