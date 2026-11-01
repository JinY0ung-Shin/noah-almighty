import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { sanitizeName } from "./marketplace.js";
import { runPython } from "./pythonExec.js";

// Per-user SSH host-trust store. hex-ssh verifies host keys fail-closed against
// a known_hosts file (its `KNOWN_HOSTS_PATH`), RE-READING it on every connection
// — so adding a host here takes effect immediately, even mid-session. We keep one
// file per avatar OWNER under the data volume so trust persists across container
// restarts and stays isolated per user (mirroring the per-user SSH key). The
// avatar manages it itself via the `mcp__ssh_trust__*` tools (host fingerprints
// are public data, not secrets, so the agent may handle them directly).

/** The per-user known_hosts path injected into hex-ssh as KNOWN_HOSTS_PATH. */
export function knownHostsPath(userId: string, config: AppConfig): string {
  return path.join(config.dataDir, "ssh", sanitizeName(userId), "known_hosts");
}

export interface TrustedHostEntry {
  /** Host token as stored (bare host for port 22, `[host]:port` otherwise). */
  host: string;
  /** SSH key type, e.g. `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`. */
  keyType: string;
  /** `SHA256:…` (unpadded base64), the same form hex-ssh computes. */
  fingerprint: string;
}

/** The host token hex-ssh matches against: bare host on :22, `[host]:port` else. */
function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** `SHA256:` + unpadded-base64 sha256 of the raw key — hex-ssh's exact format. */
function fingerprintOf(keyBase64: string): string {
  const raw = Buffer.from(keyBase64, "base64");
  return "SHA256:" + createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
}

/** Parse a known_hosts file body into entries (ignoring comments/markers). */
export function parseKnownHosts(content: string): TrustedHostEntry[] {
  const out: TrustedHostEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    // Skip a leading @marker (@cert-authority / @revoked) — we don't emit them.
    const base = parts[0].startsWith("@") ? parts.slice(1) : parts;
    if (base.length < 3) {
      continue;
    }
    const [hostField, keyType, keyBase64] = base;
    for (const host of hostField.split(",")) {
      out.push({ host, keyType, fingerprint: fingerprintOf(keyBase64) });
    }
  }
  return out;
}

/**
 * Insert/replace a known_hosts line, de-duplicated by (host token, key type) so
 * re-trusting a host that rotated its key updates rather than appends. Returns
 * the new file body and whether anything changed.
 */
export function upsertHostLine(content: string, newLine: string): { body: string; changed: boolean } {
  const wanted = newLine.trim();
  const [host, keyType] = wanted.split(/\s+/);
  const kept: string[] = [];
  let droppedDifferent = false; // an existing same-host+type line with a DIFFERENT value
  let foundIdentical = false; // the exact line is already present
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const p = trimmed.split(/\s+/);
    if (p[0] === host && p[1] === keyType) {
      // Same host+type: drop it (the new one is appended below). Note whether it
      // was identical (no real change) or a rotated key (a change).
      if (trimmed === wanted) {
        foundIdentical = true;
      } else {
        droppedDifferent = true;
      }
      continue;
    }
    kept.push(trimmed);
  }
  kept.push(wanted);
  const body = kept.join("\n") + "\n";
  // Changed unless the exact line was already present and nothing was rotated.
  const changed = droppedDifferent || !foundIdentical;
  return { body, changed };
}

/**
 * Fetch a host's public key over a TCP SSH handshake using paramiko (present in
 * the image; the container has no `ssh-keyscan`). Returns the known_hosts line
 * and its fingerprint. Throws on connect/timeout/missing-python.
 */
export async function fetchHostKey(
  host: string,
  port: number,
): Promise<{ line: string; fingerprint: string; keyType: string }> {
  const script = [
    "import sys, socket, base64, hashlib, paramiko",
    "host, port = sys.argv[1], int(sys.argv[2])",
    "s = socket.create_connection((host, port), timeout=8)",
    "t = paramiko.Transport(s); t.start_client(timeout=8)",
    "k = t.get_remote_server_key(); t.close()",
    'fp = "SHA256:" + base64.b64encode(hashlib.sha256(k.asbytes()).digest()).decode().rstrip("=")',
    'tok = host if port == 22 else "[%s]:%d" % (host, port)',
    'print("%s %s %s" % (tok, k.get_name(), k.get_base64()))',
    "print(fp)",
  ].join("\n");
  const stdout = await runPython(script, [host, String(port)], { timeout: 15_000 });
  const [line, fingerprint] = stdout.trim().split("\n");
  if (!line || !fingerprint) {
    throw new Error("EMPTY_HOST_KEY");
  }
  const keyType = line.split(/\s+/)[1] ?? "";
  return { line, fingerprint, keyType };
}

/** Fetch a host's key and add it to the user's known_hosts. Returns its entry. */
export async function addTrustedHost(
  userId: string,
  config: AppConfig,
  host: string,
  port = 22,
): Promise<{ entry: TrustedHostEntry; changed: boolean }> {
  const { line, fingerprint, keyType } = await fetchHostKey(host, port);
  const file = knownHostsPath(userId, config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    /* no file yet */
  }
  const { body, changed } = upsertHostLine(existing, line);
  await fs.writeFile(file, body);
  return { entry: { host: hostToken(host, port), keyType, fingerprint }, changed };
}

/** List trusted hosts for the user (empty if none). */
export async function listTrustedHosts(
  userId: string,
  config: AppConfig,
): Promise<TrustedHostEntry[]> {
  try {
    const content = await fs.readFile(knownHostsPath(userId, config), "utf8");
    return parseKnownHosts(content);
  } catch {
    return [];
  }
}

/** Remove all entries for a host token. Returns how many lines were removed. */
export async function removeTrustedHost(
  userId: string,
  config: AppConfig,
  host: string,
  port = 22,
): Promise<number> {
  const file = knownHostsPath(userId, config);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return 0;
  }
  const token = hostToken(host, port);
  // Also accept a bare host the caller passed even if stored as `[host]:port`.
  const kept: string[] = [];
  let removed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const first = trimmed.split(/\s+/)[0];
    if (first === token || first === host) {
      removed += 1;
      continue;
    }
    kept.push(trimmed);
  }
  if (removed > 0) {
    await fs.writeFile(file, kept.length ? kept.join("\n") + "\n" : "");
  }
  return removed;
}
