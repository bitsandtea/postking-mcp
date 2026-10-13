import { describe, expect, it } from "vitest";
import { insufficientCreditsCostLine } from "../src/credits-message.js";

describe("insufficientCreditsCostLine", () => {
  it("states cost, balance, affordable count and the top-up page", () => {
    const line = insufficientCreditsCostLine({
      action: "seo.article",
      needed: 600,
      balance: 420,
      affordableCount: 7,
      topUpUrl: "/dashboard/settings/usage",
    });
    expect(line).toContain("needs 600 credits for seo.article");
    expect(line).toContain("Current balance: 420");
    expect(line).toContain("covers 7 of the requested items");
    expect(line).toContain("/dashboard/settings/usage");
  });

  it("returns undefined for older servers that send no details", () => {
    expect(insufficientCreditsCostLine(undefined)).toBeUndefined();
    expect(insufficientCreditsCostLine({})).toBeUndefined();
  });
});
