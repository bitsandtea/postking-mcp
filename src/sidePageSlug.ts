/**
 * Encode boundary for 2-level nested side-page slugs.
 *
 * `list_side_pages` (and every other side-page tool) surfaces `SidePage.slug`
 * in its STORAGE form: the real path with a forward slash, e.g.
 * `"features/feature-1"`. But every agent-v1 side-page route addresses the
 * page through a single Next.js dynamic path segment (`[sidePageSlug]`), so
 * PostKing substitutes `~` for `/` in the URL: the URL-SEGMENT form, e.g.
 * `"features~feature-1"`.
 *
 * Source of truth: `PostKing/src/utils/sidePageSlugPath.ts` (`toUrlSegment` /
 * `fromUrlSegment`) — keep this in sync with that file, don't let it drift.
 * MCP only ever encodes on the way OUT (into a request path), never decodes,
 * so only `toUrlSegment` is ported here.
 *
 * A single-segment slug (the overwhelming majority of side pages — no `/` in
 * storage form) round-trips byte-identically, since there's nothing to
 * substitute.
 */

const URL_SEGMENT_SEPARATOR = "~";
const STORAGE_SEPARATOR = "/";

/** Storage form (`"features/feature-1"`) → URL-segment form
 * (`"features~feature-1"`), for interpolating a side-page key into a request
 * path. A single-segment slug is unchanged. */
export function toUrlSegment(storageSlug: string): string {
  return storageSlug.split(STORAGE_SEPARATOR).join(URL_SEGMENT_SEPARATOR);
}
