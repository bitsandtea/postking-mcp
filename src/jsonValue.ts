import { z } from "zod";

/**
 * Arbitrary JSON value with a concrete JSON-schema `type` on every node.
 *
 * `z.any()` / `z.unknown()` render as an untyped `{}` node (flagged by
 * directory review, and pre-stringified by some MCP clients), and a recursive
 * `z.lazy` renders as a `$ref` with no `type`. So the schema is nested
 * explicitly: levels 1-4 are fully typed; only below that (array items / object
 * values at depth 5+) is anything accepted, so no payload that worked before is
 * rejected.
 */
// Fresh instances per level: zod-to-json-schema turns reused schema instances into `$ref`s.
const scalar = () => [z.string(), z.number(), z.boolean(), z.null()] as const;

const level5: z.ZodType<unknown> = z.union([...scalar(), z.array(z.any()), z.record(z.string(), z.any())]);
const level4: z.ZodType<unknown> = z.union([...scalar(), z.array(level5), z.record(z.string(), level5)]);
const level3: z.ZodType<unknown> = z.union([...scalar(), z.array(level4), z.record(z.string(), level4)]);
const level2: z.ZodType<unknown> = z.union([...scalar(), z.array(level3), z.record(z.string(), level3)]);

/** Arbitrary JSON value (string, number, boolean, null, array, or object). */
export const jsonValue: z.ZodType<unknown> = z.union([...scalar(), z.array(level2), z.record(z.string(), level2)]);

/** Arbitrary JSON object (string keys, any JSON value). */
export const jsonObject = z.record(z.string(), jsonValue);
