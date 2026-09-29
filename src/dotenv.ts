/**
 * A minimal dotenv reader: `KEY=VALUE` lines, `#` comments, blank lines
 * skipped, one pair of matching surrounding quotes removed. Values are taken
 *literally — no variable expansion, no escapes, no multi-line values. The
 *last assignment of a name wins, as a shell would.
 */

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses dotenv text into the names it assigns. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(raw);
    if (!match) continue;
    const [, name, rest] = match;
    if (name === undefined || rest === undefined) continue;
    values[name] = unquote(rest.trim());
  }
  return values;
}

/** Strips one pair of matching quotes, so a value may keep spaces or a `#`. */
function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  // An unquoted value ends at the first ` #`-comment, as dotenv files are read.
  return value.replace(/\s+#.*$/, '').trim();
}
