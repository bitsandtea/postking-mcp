import { z } from "zod";

export type Detail = "short" | "medium" | "full";

/**
 * Zod field for a tool's `detail` param.
 * Pass "short" as the default for LIST tools, "full" for single-item get/view tools.
 */
export function detailParam(def: Detail) {
  return z
    .enum(["short", "medium", "full"])
    .default(def)
    .describe(
      'Verbosity of returned item(s): "short" = id + primary label + status (cheap list scan); ' +
        '"medium" = key summary fields + counts (a useful glance); "full" = the complete object. ' +
        `Default "${def}". Lists default to "short" — to zoom into one item, call its get/view tool with detail="medium" or "full".`
    );
}

/** A per-entity projector. `full` is always the identity (raw row), so only short+medium are defined. */
export interface Projector<T> {
  short: (row: T) => unknown;
  medium: (row: T) => unknown;
}

/** Project a single row to the requested detail level. */
export function project<T>(detail: Detail, row: T, p: Projector<T>): unknown {
  if (detail === "full") return row;
  return detail === "medium" ? p.medium(row) : p.short(row);
}

/** Project an array of rows to the requested detail level. */
export function projectList<T>(detail: Detail, rows: T[], p: Projector<T>): unknown[] {
  return rows.map((r) => project(detail, r, p));
}

/** Truncate a string field for short/medium views; returns null for non-strings. */
export function truncate(s: unknown, n: number): string | null {
  if (typeof s !== "string") return null;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Pick a subset of keys, dropping undefined values. */
export function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
