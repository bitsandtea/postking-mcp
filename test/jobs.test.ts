import { describe, expect, it } from "vitest";
import { derivedJobFields, normalizeJobShape } from "../src/tools/jobs.js";

describe("normalizeJobShape (non-Operation pollUrls)", () => {
  it("LP generate status: completed -> done", () => {
    const n = normalizeJobShape({ operationId: "x", status: "completed", result: { versionId: 1 } });
    expect(n.state).toBe("completed");
    expect(derivedJobFields(n)).toEqual({ done: true, summary: "completed" });
  });

  it("maps processing -> running and pending stays pending", () => {
    expect(derivedJobFields(normalizeJobShape({ status: "processing", progress: { current: 1, total: 2 } })).done).toBe(false);
    expect(normalizeJobShape({ status: "processing" }).state).toBe("running");
    expect(normalizeJobShape({ status: "pending" }).state).toBe("pending");
  });

  it("failed carries error into summary", () => {
    const f = derivedJobFields(normalizeJobShape({ status: "failed", error: "boom" }));
    expect(f).toEqual({ done: true, summary: "failed: boom" });
  });

  it("completed_with_errors is terminal partially_failed", () => {
    const n = normalizeJobShape({ status: "completed_with_errors" });
    expect(n.state).toBe("partially_failed");
    expect(derivedJobFields(n).done).toBe(true);
  });

  it("unwraps side-page { operationStatus: {...} } (object or JSON string)", () => {
    const obj = normalizeJobShape({ operationId: "o", operationStatus: { status: "completed" } });
    expect(obj.state).toBe("completed");
    const str = normalizeJobShape({ operationId: "o", operationStatus: JSON.stringify({ status: "failed", error: "e" }) });
    expect(derivedJobFields(str).done).toBe(true);
  });

  it("leaves Operation rows (with state) untouched", () => {
    const row = { id: "a", state: "running", status: "weird" };
    expect(normalizeJobShape(row)).toBe(row);
  });
});
