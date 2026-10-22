import { describe, expect, it } from "vitest";
import { unwrapBrief } from "../src/tools/seo/briefs.js";

describe("unwrapBrief", () => {
  it("unwraps { brief } and passes bare rows through", () => {
    const row = { id: "b1" };
    expect(unwrapBrief({ brief: row })).toBe(row);
    expect(unwrapBrief(row)).toBe(row);
  });
});

import { getBriefProj } from "../src/tools/seo/briefs.js";

describe("getBriefProj on the wrapped API response", () => {
  const wrapped = {
    brief: {
      id: "b1",
      type: "landing",
      status: "drafted",
      title: "Hub",
      briefData: { targetUrl: "/for-x", sections: [1, 2] },
      roadmapItem: { title: "Roadmap T", cluster: { id: "c1", name: "Cluster A" } },
    },
  };
  it("short", () => {
    expect(getBriefProj.short(wrapped)).toEqual({ id: "b1", type: "landing", status: "drafted" });
  });
  it("medium", () => {
    expect(getBriefProj.medium(wrapped)).toEqual({
      id: "b1", type: "landing", status: "drafted", title: "Hub",
      clusterName: "Cluster A", briefSummary: "outline present", sidePageUrl: "/for-x",
      truths: [], truthConflicts: [],
    });
  });
  it("medium includes compact truths + conflicts", () => {
    const withTruths = {
      ...wrapped,
      truths: [{ truthId: "t1", slug: "s", name: "N", reason: "r", contentHash: "h", snapshot: "x", status: "changed" }],
      truthConflicts: [{ truthIds: ["t1", "t2"], note: "n" }],
    };
    const out = getBriefProj.medium(withTruths) as Record<string, unknown>;
    expect(out.truths).toEqual([{ truthId: "t1", name: "N", reason: "r", status: "changed" }]);
    expect(out.truthConflicts).toEqual([{ truthIds: ["t1", "t2"], note: "n" }]);
  });
});
