/**
 * Minimal structured logger. All output goes to process.stderr so it never
 * contaminates the JSON-RPC protocol channel on the stdio transport.
 *
 * Log format: [<ISO-timestamp>] [<scope>] <msg>[ <truncated-json>]\n
 */

export function summarize(value: unknown, max = 600): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= max) return s;
  const over = s.length - max;
  return s.slice(0, max) + `…(+${over})`;
}

export function log(scope: string, msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${scope}] ${msg}`;
  if (data !== undefined) {
    line += " " + summarize(data);
  }
  process.stderr.write(line + "\n");
}
