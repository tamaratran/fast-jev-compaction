/**
 * Secret redaction for what leaves the machine. The Jev request carries the
 * history's texts and tool inputs; anything shaped like a credential in them is
 * replaced before the request is built. The transcript itself is never changed.
 *
 * Pattern-based by necessity: `$.env.get` takes literal names only, so the hook
 * cannot enumerate the environment. Values the hook does hold (its own API key)
 * are passed as `known` and replaced exactly.
 */

export const REDACTED = '[REDACTED]';

/** Credentials with a recognisable shape, replaced whole. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant|or|kimi|proj|live|test)?-?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenRouter, Kimi, OpenAI, Stripe
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bpit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // GoHighLevel private integration
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\bGOCSPX-[0-9A-Za-z_-]{20,}/g, // Google OAuth client secret
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g, // Discord bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `prefix_<long random>` keys (Typesafe-style); the tail must look random, not like a snake_case name. */
const PREFIXED = /\b([A-Za-z]{2,10})_([A-Za-z0-9_.-]{40,})/g;

/** `NAME=value`, `"apiKey": "value"`, `--token value`: keep the name, drop the value. */
const ASSIGNMENT =
  // repetition is bounded ({0,4}, {1,30}): an unbounded (?:[A-Za-z0-9]+[_-])* backtracks quadratically on snake_case runs
  /((?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:api[_-]?key|apikey|key|token|secret|password|passwd|pwd|auth|credentials?|client[_-]?secret|access[_-]?key)(?:[_-][A-Za-z0-9]{1,30}){0,4}["']?[ \t]{0,4}[:=][ \t]{0,4}["']?)([^\s"'`,;)\]}\\<>]{8,})/gi;

/** `scheme://user:password@host`: keep the user, drop the password. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/@:]{1,64}:)([^\s@/]{6,})(@)/gi;

/** Base64 secrets with `/` or `+` (AWS secret access keys and the like), which OPAQUE splits at the slash. */
const BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;

/** `--token value` style flags on command lines. */
const FLAG = /(--(?:api-?key|token|password|secret|auth|client-secret)[=\s]+["']?)([^\s"'`]{8,})/gi;

/** `Bearer <token>` / `Basic <token>` in headers and curl lines. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g;

/** Long opaque strings: at least 32 chars, letters and digits mixed. */
const OPAQUE = /(?<![A-Za-z0-9_\-/.\\])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/.\\])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksOpaque(s: string): boolean {
  if (UUID.test(s)) return false; // ids, not secrets
  if (/^[0-9a-f]{40}$/i.test(s) || /^[0-9a-f]{64}$/i.test(s)) return false; // git / sha256 digests
  const digits = (s.match(/[0-9]/g) ?? []).length;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (digits < 4 || letters < 8) return false;
  if (digits / s.length < 0.2) {
    // mostly letters: only an identifier-shaped string is exempt
    if (/^[a-z]+(?:[_-][a-z0-9]+)+$/.test(s)) return false; // snake/kebab names
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return false; // CONSTANT_NAMES
  }
  return true;
}

/** Values after `key =` that are code or references, not credentials. */
function looksLikeCode(value: string): boolean {
  return (
    /^(?:true|false|null|undefined|none)$/i.test(value) ||
    /^[$%]/.test(value) || // $VAR, ${VAR}, %VAR%
    /^[/~.]/.test(value) || // paths
    value.includes('(') || // calls: fs.readFileSync(
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[|&?]*[{[]?$/.test(value) // member access: j.mcpOAuth
  );
}

export type Redaction = { text: string; count: number };

/** Replaces every credential-shaped substring of `text`. */
export function redactSecrets(text: string, known: readonly string[] = []): Redaction {
  let count = 0;
  let out = text;
  for (const secret of known) {
    if (secret.length < 8) continue;
    const parts = out.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  out = out.replace(PREFIXED, (m, _prefix: string, tail: string) => {
    if (/\.[a-z]{1,5}$/.test(tail) || !looksOpaque(tail.replace(/\./g, ''))) return m;
    count++;
    return REDACTED;
  });
  out = out.replace(URL_CREDENTIALS, (m, head: string, value: string, at: string) => {
    if (value.includes(REDACTED)) return m;
    count++;
    return `${head}${REDACTED}${at}`;
  });
  out = out.replace(BASE64, (m) => {
    if (!/[/+]/.test(m)) return m; // no slash or plus: OPAQUE decides
    const upper = (m.match(/[A-Z]/g) ?? []).length;
    const lower = (m.match(/[a-z]/g) ?? []).length;
    const digits = (m.match(/[0-9]/g) ?? []).length;
    if (upper < 3 || lower < 3 || digits < 2) return m; // paths and URL routes are rarely mixed case
    const segments = m.split('/').filter(Boolean);
    if (segments.length > 1 && segments.every((s) => /^(?:[A-Za-z]+[0-9]*|v?[0-9]+)$/.test(s))) return m; // /api/v2/GetUserProfile/Settings2024
    count++;
    return REDACTED;
  });
  out = out.replace(AUTH_SCHEME, (_m, scheme: string, value: string) => {
    if (value === REDACTED) return _m;
    count++;
    return `${scheme} ${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT, (m, name: string, value: string) => {
    if (value.includes(REDACTED) || looksLikeCode(value)) return m;
    count++;
    return `${name}${REDACTED}`;
  });
  out = out.replace(FLAG, (m, flag: string, value: string) => {
    if (value.includes(REDACTED)) return m;
    count++;
    return `${flag}${REDACTED}`;
  });
  out = out.replace(OPAQUE, (m) => {
    if (!looksOpaque(m)) return m;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

/** Redacts every string inside a JSON-shaped value; returns a new value and the total count. */
export function redactDeep<T>(value: T, known: readonly string[] = []): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v, known);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
