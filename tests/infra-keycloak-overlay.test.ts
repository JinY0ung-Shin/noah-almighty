// Login through the bundled Keycloak: the optional overlay (docker-compose.keycloak.yml), the realm it
// imports (docker/keycloak/noah-realm.json), the nginx paths that carry Keycloak's pages
// (docker/nginx/noah.conf.template), the secrets docker/pi/setup-host.sh makes, and the server's reading
// of its three values (`parseKeycloakConfig`). The compose / realm / template half is a static contract —
// nothing here talks to Docker; the live check (real Keycloak behind real nginx) is described in
// docs/architecture/build-run-verify.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKeycloakConfig } from "../src/server/config.js";
import {
  KEYCLOAK_ADMIN_ROLE,
  KEYCLOAK_CALLBACK_PATH,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_REALM,
  KEYCLOAK_TEAM_GROUP,
  createHttpKeycloakClient,
} from "../src/server/keycloak.js";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface RealmFile {
  realm: string;
  registrationAllowed: boolean;
  editUsernameAllowed: boolean;
  passwordPolicy: string;
  roles: { realm: { name: string }[] };
  groups: { name: string }[];
  clients: {
    clientId: string;
    publicClient: boolean;
    secret: string;
    directAccessGrantsEnabled: boolean;
    implicitFlowEnabled: boolean;
    serviceAccountsEnabled: boolean;
    redirectUris: string[];
    attributes: Record<string, string>;
    optionalClientScopes: string[];
    defaultClientScopes: string[];
  }[];
  users: { username: string; serviceAccountClientId?: string; clientRoles?: Record<string, string[]>; credentials?: unknown }[];
  components: Record<string, { config: Record<string, string[]> }[]>;
}

const realm = JSON.parse(read("docker/keycloak/noah-realm.json")) as RealmFile;

describe("the realm Keycloak imports", () => {
  it("carries the names the server's client uses", () => {
    expect(realm.realm).toBe(KEYCLOAK_REALM);
    expect(realm.groups.map((g) => g.name)).toContain(KEYCLOAK_TEAM_GROUP);
    expect(realm.roles.realm.map((r) => r.name)).toContain(KEYCLOAK_ADMIN_ROLE);
    expect(realm.clients.map((c) => c.clientId)).toEqual([KEYCLOAK_CLIENT_ID, "admin-cli"]);
  });

  it("opens nothing before Noah's first pass, and switches off the default client with the password grant", () => {
    // Registration is opened by Noah (signup mode `approval`) AFTER it created the existing accounts —
    // an open form before that would let anyone take an existing Noah username first.
    expect(realm.registrationAllowed).toBe(false);
    // Keycloak adds `admin-cli` (public, password grant) to every realm; nobody uses it in this one.
    const adminCli = realm.clients.find((c) => c.clientId === "admin-cli") as unknown as { enabled: boolean; directAccessGrantsEnabled: boolean };
    expect(adminCli).toMatchObject({ enabled: false, directAccessGrantsEnabled: false });
  });

  it("makes `noah` a confidential code-flow client with PKCE, one redirect address and no secret in the file", () => {
    const [client] = realm.clients;
    expect(client.publicClient).toBe(false);
    // A placeholder Keycloak fills from its environment (setup-host.sh's keycloak.env) — never a value.
    expect(client.secret).toBe("${NOAH_KEYCLOAK_CLIENT_SECRET}");
    // Noah never handles a password for Keycloak: no password grant, no implicit flow.
    expect(client.directAccessGrantsEnabled).toBe(false);
    expect(client.implicitFlowEnabled).toBe(false);
    expect(client.attributes["pkce.code.challenge.method"]).toBe("S256");
    expect(client.redirectUris).toEqual([`https://\${NOAH_SERVER_NAME}${KEYCLOAK_CALLBACK_PATH}`]);
  });

  it("lets Noah's service account manage users and the realm, with the admin-API scope asked for per token", () => {
    const [client] = realm.clients;
    expect(client.serviceAccountsEnabled).toBe(true);
    // OPTIONAL: a person's token never carries the admin-API audience; the service account asks for it.
    expect(client.optionalClientScopes).toContain("kc-admin-api");
    expect(client.defaultClientScopes).not.toContain("kc-admin-api");
    const account = realm.users.find((u) => u.serviceAccountClientId === KEYCLOAK_CLIENT_ID);
    expect(account?.clientRoles).toEqual({ "realm-management": ["manage-users", "manage-realm"] });
    // No person is created by the file: accounts come from Noah's import or Keycloak's registration form.
    expect(realm.users).toHaveLength(1);
  });

  it("asks a new person for what Noah's signup asked: a username Noah accepts, a password of 8+, a display name", () => {
    expect(realm.passwordPolicy).toBe("length(8)");
    expect(realm.editUsernameAllowed).toBe(false);
    const profile = JSON.parse(realm.components["org.keycloak.userprofile.UserProfileProvider"][0].config["kc.user.profile.config"][0]) as {
      attributes: { name: string; required?: unknown; validations?: Record<string, Record<string, unknown>>; permissions?: { edit: string[] } }[];
    };
    const byName = new Map(profile.attributes.map((a) => [a.name, a]));
    const username = byName.get("username")!;
    expect(username.validations?.length).toEqual({ min: 3, max: 32 });
    // The same alphabet as the server's USERNAME_PATTERN (`[\w.-]`).
    const pattern = new RegExp(String(username.validations?.pattern?.pattern));
    for (const ok of ["ada", "Ada.L-1_x"]) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ["a b", "한글", "a@b"]) expect(pattern.test(bad), bad).toBe(false);
    // Nothing is required but the username; an e-mail address is not asked of a person at all.
    for (const attribute of profile.attributes) expect(attribute.required, attribute.name).toBeUndefined();
    expect(byName.get("email")?.permissions?.edit).toEqual(["admin"]);
    expect([...byName.keys()].sort()).toEqual(["email", "firstName", "username"]);
  });
});

describe("docker-compose.keycloak.yml", () => {
  const overlay = read("docker-compose.keycloak.yml");

  it("gives Noah the three values and its own copy of the client secret", () => {
    expect(overlay).toMatch(/KEYCLOAK_PUBLIC_URL: https:\/\/\$\{NOAH_SERVER_NAME:\?[^}]+\}\/sso\n/);
    expect(overlay).toContain("KEYCLOAK_INTERNAL_URL: http://keycloak:8080/sso\n");
    expect(overlay).toContain("KEYCLOAK_CLIENT_SECRET_FILE: /run/secrets/keycloak_client_secret_noah\n");
    expect(overlay).toMatch(/keycloak_client_secret_noah:\n\s+file: \$\{PI_GATEWAY_SECRETS:-\$\{PI_GATEWAY_HOME\}\/secrets\}\/noah\/keycloak_client_secret\n/);
    // Never inline: the server refuses an inline secret (parseKeycloakConfig).
    expect(overlay).not.toMatch(/KEYCLOAK_CLIENT_SECRET:/);
  });

  it("never makes compose itself read a secret file (whoever runs compose cannot open the secrets folder)", () => {
    expect(overlay).not.toMatch(/^\s+env_file:/m);
    expect(overlay).toMatch(/keycloak_env:\n\s+file: \$\{PI_GATEWAY_SECRETS:-\$\{PI_GATEWAY_HOME\}\/secrets\}\/keycloak\/keycloak\.env\n/);
    expect(overlay).toContain("set -a && . /run/secrets/keycloak_env && set +a && exec");
    // …and the file is readable by the uid Keycloak runs as, nobody else.
    const script = read("docker/pi/setup-host.sh");
    expect(script).toContain("KEYCLOAK_UID=1000");
    expect(script).toContain('chown "$KEYCLOAK_UID:$KEYCLOAK_UID" "$KEYCLOAK_ENV"; chmod 0400 "$KEYCLOAK_ENV"');
  });

  it("publishes nothing on the host and keeps Keycloak's back side on internal networks", () => {
    expect(overlay).not.toMatch(/^\s+ports:/m);
    for (const network of ["noah-auth", "keycloak-db"]) {
      expect(overlay, network).toMatch(new RegExp(`\\n  ${network}:\\n    internal: true\\n`));
    }
  });

  it("runs Keycloak behind nginx at /sso with the browser's address in every token", () => {
    expect(overlay).toContain("KC_HOSTNAME: https://${NOAH_SERVER_NAME}/sso\n");
    expect(overlay).toContain('KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"\n');
    expect(overlay).toContain("KC_HTTP_RELATIVE_PATH: /sso\n");
    expect(overlay).toContain("KC_PROXY_HEADERS: xforwarded\n");
    // Only nginx's forwarded headers are believed (the same pinned address Noah trusts).
    expect(overlay).toContain("KC_PROXY_TRUSTED_ADDRESSES: ${NOAH_NGINX_IP:-172.16.249.10}\n");
    expect(overlay).toContain("exec /opt/keycloak/bin/kc.sh start --import-realm");
    expect(overlay).toContain("./docker/keycloak/noah-realm.json:/opt/keycloak/data/import/noah-realm.json:ro");
  });
});

describe("nginx carries Keycloak's login pages, and nothing else of Keycloak", () => {
  const template = read("docker/nginx/noah.conf.template");
  const block = template.slice(template.indexOf("location ^~ /sso/ {"), template.indexOf("    location / {"));

  it("passes the realm pages and their static files only", () => {
    // The `noah` realm only: Keycloak's own `master` realm has no page at the front door either.
    expect(block).toContain("location ~ ^/sso/(realms/noah|resources)/ {");
    expect(block).toContain("set $noah_keycloak_upstream http://${NOAH_KEYCLOAK_UPSTREAM};");
    // Everything else under /sso/ — the admin console and API among it — is a 404 at the front door.
    expect(block.trimEnd().endsWith("return 404;\n    }")).toBe(true);
    const passed = new RegExp("^/sso/(realms/noah|resources)/");
    for (const path of ["/sso/admin/realms/noah/users", "/sso/realms/master/protocol/openid-connect/token", "/sso/realms/noahx/", "/sso/"]) {
      expect(passed.test(path), path).toBe(false);
    }
    expect(passed.test("/sso/realms/noah/protocol/openid-connect/auth")).toBe(true);
    expect(read("docker-compose.nginx.yml")).toContain("NOAH_KEYCLOAK_UPSTREAM: keycloak:8080\n");
  });

  it("never hands Noah's session cookie to Keycloak", () => {
    expect(block).toContain("proxy_set_header Cookie $noah_keycloak_cookie;");
    const strip = (cookie: string): string => {
      let value = cookie;
      // The template runs the expression twice (a second cookie of the same name).
      for (let pass = 0; pass < 2; pass += 1) {
        const hit = /^(.*?)(?:^|;\s*)ac_session=[^;]*(.*)$/.exec(value);
        if (hit) value = hit[1] + hit[2];
      }
      const lead = /^;\s*(.*)$/.exec(value);
      if (lead) value = lead[1];
      return value;
    };
    // The two expressions of the template, on the shapes a Cookie header takes.
    expect(block.split('~ "^(.*?)(?:^|;\\s*)ac_session=[^;]*(.*)$"')).toHaveLength(3);
    expect(block).toContain('~ "^;\\s*(.*)$"');
    expect(strip("ac_session=SECRET")).toBe("");
    expect(strip("ac_session=SECRET; AUTH_SESSION_ID=a")).toBe("AUTH_SESSION_ID=a");
    expect(strip("AUTH_SESSION_ID=a; ac_session=SECRET")).toBe("AUTH_SESSION_ID=a");
    expect(strip("AUTH_SESSION_ID=a; ac_session=SECRET; KC_RESTART=b")).toBe("AUTH_SESSION_ID=a; KC_RESTART=b");
    expect(strip("AUTH_SESSION_ID=a; KC_RESTART=b")).toBe("AUTH_SESSION_ID=a; KC_RESTART=b");
    expect(strip("ac_session=ONE; AUTH_SESSION_ID=a; ac_session=TWO")).toBe("AUTH_SESSION_ID=a");
  });
});

describe("docker/pi/setup-host.sh makes Keycloak's secrets once", () => {
  const script = read("docker/pi/setup-host.sh");

  it("keeps existing values and refuses half a set, and its tight umask does not reach the files made after it", () => {
    // In a subshell: the .env the script creates further down must stay readable to whoever runs compose.
    expect(script).toMatch(/\n  \(\n  umask 077\n[\s\S]*?\n  \)\n/);
    expect(script).toContain('if [ -s "$KEYCLOAK_ENV" ] && [ -s "$KEYCLOAK_DB_PASSWORD" ]; then');
    expect(script).toContain("restore the missing file from a backup");
    for (const key of ["KC_DB_PASSWORD", "KC_BOOTSTRAP_ADMIN_PASSWORD", "NOAH_KEYCLOAK_CLIENT_SECRET"]) {
      expect(script, key).toContain(`printf '${key}=%s\\n'`);
    }
    expect(script).toContain('DEST="$SECRETS/noah/keycloak_client_secret"');
  });
});

describe("parseKeycloakConfig — all three values or none", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const secretFile = (content: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-keycloak-config-"));
    dirs.push(dir);
    const file = path.join(dir, "secret");
    fs.writeFileSync(file, content);
    return file;
  };
  const none = { publicUrl: "", internalUrl: "", clientSecretFile: "", inlineClientSecret: "" };

  it("is off when nothing is set", () => {
    expect(parseKeycloakConfig(none)).toBeUndefined();
  });

  it("reads the three values, trimming a trailing slash and the file's newline", () => {
    expect(
      parseKeycloakConfig({ ...none, publicUrl: "https://noah.corp.example/sso/", internalUrl: "http://keycloak:8080/sso", clientSecretFile: secretFile("s3cret\n") }),
    ).toEqual({ publicUrl: "https://noah.corp.example/sso", internalUrl: "http://keycloak:8080/sso", clientSecret: "s3cret" });
  });

  it("stops the boot on part of a configuration, an inline secret, or a file that is not one secret", () => {
    const file = secretFile("s3cret\n");
    const full = { ...none, publicUrl: "https://noah.corp.example/sso", internalUrl: "http://keycloak:8080/sso", clientSecretFile: file };
    for (const missing of ["publicUrl", "internalUrl", "clientSecretFile"] as const) {
      expect(() => parseKeycloakConfig({ ...full, [missing]: "" }), missing).toThrow("set all three");
    }
    expect(() => parseKeycloakConfig({ ...full, inlineClientSecret: "s3cret" })).toThrow("KEYCLOAK_CLIENT_SECRET is not read");
    expect(() => parseKeycloakConfig({ ...full, clientSecretFile: secretFile("") })).toThrow("is empty");
    expect(() => parseKeycloakConfig({ ...full, clientSecretFile: secretFile("a b\n") })).toThrow("alone on one line");
    expect(() => parseKeycloakConfig({ ...full, clientSecretFile: path.join(os.tmpdir(), "no-such-noah-secret") })).toThrow("cannot be read");
    expect(() => parseKeycloakConfig({ ...full, publicUrl: "noah.corp.example/sso" })).toThrow("KEYCLOAK_PUBLIC_URL must be an absolute URL");
    expect(() => parseKeycloakConfig({ ...full, internalUrl: "http://user:pw@keycloak:8080/sso" })).toThrow("must not carry credentials");
    // No message carries the secret.
    try {
      parseKeycloakConfig({ ...full, clientSecretFile: secretFile("two words\n") });
    } catch (error) {
      expect(String(error)).not.toContain("two words");
    }
  });
});

describe("the HTTP client's addresses", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answers: (() => Response)[] = [];
  const fetchStub = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return (answers.shift() ?? (() => new Response("{}", { status: 200 })))();
  }) as typeof fetch;
  const client = createHttpKeycloakClient(
    { publicUrl: "https://noah.corp.example/sso", internalUrl: "http://keycloak:8080/sso", clientSecret: "s3cret" },
    fetchStub,
  );
  afterEach(() => {
    calls.length = 0;
    answers.length = 0;
  });

  it("sends the browser to the PUBLIC address and comes back to Noah's own callback", () => {
    const url = new URL(client.authorizationUrl({ state: "st", codeChallenge: "ch", loginHint: "ada" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://noah.corp.example/sso/realms/noah/protocol/openid-connect/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "noah",
      response_type: "code",
      scope: "openid",
      redirect_uri: "https://noah.corp.example/api/auth/oidc/callback",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      login_hint: "ada",
    });
    expect(client.authorizationUrl({ state: "st", codeChallenge: "ch", register: true })).toContain("/protocol/openid-connect/registrations?");
    // The secret never rides a URL the browser sees.
    expect(url.toString()).not.toContain("s3cret");
  });

  it("makes every call of its own on the INTERNAL address, refusing redirects", async () => {
    answers.push(() => new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), { status: 200 }));
    await client.exchangeCode("the-code", "the-verifier");
    expect(calls[0].url).toBe("http://keycloak:8080/sso/realms/noah/protocol/openid-connect/token");
    expect(calls[0].init.redirect).toBe("error");
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
      client_id: "noah",
      client_secret: "s3cret",
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://noah.corp.example/api/auth/oidc/callback",
      code_verifier: "the-verifier",
    });
  });

  it("asks for the admin-API scope on the service account's token, reuses the token, and retries once on a 401", async () => {
    const token = () => new Response(JSON.stringify({ access_token: "sa-token", expires_in: 300 }), { status: 200 });
    answers.push(token, () => new Response(null, { status: 204 }), () => new Response(null, { status: 204 }));
    await client.setPassword("u1", "password123");
    await client.logoutUser("u1");
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toMatchObject({ grant_type: "client_credentials", scope: "kc-admin-api" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://keycloak:8080/sso/realms/noah/protocol/openid-connect/token",
      "http://keycloak:8080/sso/admin/realms/noah/users/u1/reset-password",
      "http://keycloak:8080/sso/admin/realms/noah/users/u1/logout",
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ type: "password", value: "password123", temporary: false });

    // A token Keycloak stopped accepting: one new token, one retry.
    calls.length = 0;
    answers.push(() => new Response("{}", { status: 401 }), token, () => new Response(null, { status: 204 }));
    await client.logoutUser("u1");
    expect(calls.map((c) => c.url.split("/sso/")[1])).toEqual([
      "admin/realms/noah/users/u1/logout",
      "realms/noah/protocol/openid-connect/token",
      "admin/realms/noah/users/u1/logout",
    ]);
  });

  it("keeps passwords, codes and the secret out of its error messages", async () => {
    answers.push(() => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Code not valid: the-code" }), { status: 400 }));
    const error = await client.exchangeCode("the-code", "the-verifier").catch((e: unknown) => e);
    expect(String(error)).toContain("invalid_grant");
    for (const leak of ["the-code", "the-verifier", "s3cret"]) expect(String(error)).not.toContain(leak);
  });
});
