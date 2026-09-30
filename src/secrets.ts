// Secret values masked before a tool output is saved to a file (hooks/fast-jev.ts). The session transcript keeps the
// original; the saved copy must not become one more place a key lives. Families are value-based, as in common secret
// sweeps: a value, not a field name, is a secret. A match whose body is one repeated character is a
// placeholder (`sk-xxxxxxxx…`) and is left alone.
const FAMILIES: ReadonlyArray<readonly [name: string, pattern: RegExp, keep?: number]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['sk-proj', /sk-proj-[A-Za-z0-9_-]{30,}/g],
  ['sk-ant', /sk-ant-[A-Za-z0-9_-]{30,}/g],
  ['sk-or-v1', /sk-or-v1-[A-Za-z0-9]{30,}/g],
  ['sk', /(?<![A-Za-z0-9-])sk-[A-Za-z0-9_.-]{16,}/g],
  ['github-pat', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['glpat', /glpat-[A-Za-z0-9_-]{20,}/g],
  ['gh-token', /gh[opsu]_[A-Za-z0-9]{30,}/g],
  ['hf', /hf_[A-Za-z0-9]{30,}/g],
  ['nia', /nk_[A-Za-z0-9]{20,}/g],
  ['google-api', /AIza[0-9A-Za-z_-]{30,}/g],
  ['slack', /xox[abpr]-[0-9A-Za-z-]{20,}/g],
  ['aws-akia', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g],
  ['aws-secret', /(aws_secret_access_key["'\s=:]+)[A-Za-z0-9/+=]{30,}/gi, 1],
  ['pplx', /pplx-[A-Za-z0-9]{20,}/g],
  ['xai', /xai-[A-Za-z0-9]{20,}/g],
  ['groq', /gsk_[A-Za-z0-9]{20,}/g],
  ['sakana', /fish_[A-Za-z0-9_]{20,}/g],
  ['keenable', /keen_[A-Za-z0-9_]{20,}/g],
  ['sendgrid', /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
  ['telegram', /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/g],
  ['bearer', /(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, 1],
];

/** `text` with the secret values of known families replaced by `[REDACTED:<family>]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [name, pattern, keep] of FAMILIES) {
    out = out.replace(pattern, (match: string, label?: string) => {
      const kept = keep && typeof label === 'string' ? label : '';
      const body = match.slice(kept.length).replace(/^[A-Za-z]+[_-](?:[a-z0-9]+-)?/, '');
      return new Set(body).size < 2 ? match : `${kept}[REDACTED:${name}]`;
    });
  }
  return out;
}
