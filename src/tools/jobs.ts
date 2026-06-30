import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { config } from "../config.js";
import { etaFor } from "../etas.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, type Projector } from "../detail.js";

const opProjector: Projector<Record<string, unknown>> = {
  short: (op) => ({ id: op.id, kind: op.kind, state: op.state }),
  medium: (op) => ({
    id: op.id,
    kind: op.kind,
    state: op.state,
    scopeId: op.scopeId,
    progress: op.progress,
    startedAt: op.startedAt,
    finishedAt: op.finishedAt,
  }),
};

export function derivedJobFields(d: Record<string, unknown>): { done: boolean; summary: string } {
  const DONE_STATES = new Set(["completed", "failed", "partially_failed", "cancelled"]);
  const state = String(d.state ?? "");
  const done = DONE_STATES.has(state);
  let summary: string;
  if (state === "completed") {
    summary = "completed";
  } else if (state === "failed" || state === "partially_failed") {
    const errors = Array.isArray(d.errors) ? d.errors : [];
    const firstMsg = errors.length > 0
      ? (typeof errors[0] === "string" ? errors[0] : (errors[0] as Record<string, unknown>)?.message ?? "unknown error")
      : "unknown error";
    summary = `${state}: ${firstMsg}`;
  } else if (state === "cancelled") {
    summary = "cancelled";
  } else if (state === "running") {
    const pct = typeof d.progress === "number" ? `${d.progress}%` : "…";
    summary = `running — ${pct}`;
  } else {
    summary = state || "pending";
  }
  return { done, summary };
}

const jobProjector: Projector<Record<string, unknown>> = {
  short: (d) => ({ id: d.id, kind: d.kind, state: d.state, progress: d.progress, ...derivedJobFields(d) }),
  medium: (d) => {
    const rawResult = d.result;
    let resultRef: Record<string, unknown> | null = null;
    if (rawResult !== null && typeof rawResult === "object") {
      const r = rawResult as Record<string, unknown>;
      const ref: Record<string, unknown> = {};
      if ("slug" in r) ref.slug = r.slug;
      if ("articleId" in r) ref.articleId = r.articleId;
      if ("sidePageId" in r) ref.sidePageId = r.sidePageId;
      if ("operationId" in r) ref.operationId = r.operationId;
      resultRef = Object.keys(ref).length > 0 ? ref : null;
    }
    return {
      id: d.id,
      kind: d.kind,
      state: d.state,
      progress: d.progress,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
      resultRef,
      ...derivedJobFields(d),
    };
  },
};

const jobsListProjector: Projector<Record<string, unknown>> = {
  short: (j) => ({ id: j.id, kind: j.title ?? null, state: j.status ?? null }),
  medium: (j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    createdAt: j.createdAt,
    pollUrl: j.pollUrl,
    successRedirectUrl: j.successRedirectUrl ?? null,
  }),
};

export function registerJobTools(server: McpServer) {
  // ── List jobs ─────────────────────────────────────────────────────────────
  server.tool(
    "list_jobs",
    [
      "To check a SPECIFIC operation's status, call get_job with its operationId — this list only returns the most recent ops and may omit a just-started one.",
      "List background jobs for the active brand.",
      "Use status='pending' to see in-flight ops, 'completed' to see finished ones.",
      "Use get_job with an operationId to poll a specific job — most async tools return an operationId.",
      "Supports detail param: short=id+kind+state, medium=6 key fields, full=raw.",
    ].join(" "),
    {
      status: z
        .enum(["pending", "running", "completed", "failed"])
        .optional()
        .describe("Filter by job status"),
      limit: z.number().int().min(1).max(100).optional().default(20),
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/jobs${qs}`);
      const rawJobs = (data?.jobs ?? []) as Record<string, unknown>[];
      const result = { count: rawJobs.length, detail, jobs: projectList(detail, rawJobs, jobsListProjector) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── List operations ───────────────────────────────────────────────────────
  server.tool(
    "list_operations",
    [
      "To check a SPECIFIC operation's status, call get_job with its operationId — this list only returns the most recent ops and may omit a just-started one.",
      "List recent Operations (the newer async-op system) for the active brand.",
      "Each operation has: id, kind, state (pending|running|completed|partially_failed|failed|cancelled), progress, result, errors.",
      "Use get_job with an operationId to poll a specific one.",
      "Filters: kind (e.g. seo_keyword_generate, seo_cluster_generate, lp_generate), state.",
      "Supports detail param: short=id+kind+state, medium=adds scopeId+progress+timestamps (no result/errors), full=raw including result.",
    ].join(" "),
    {
      kind: z.string().optional().describe("Filter by operation kind (e.g. seo_keyword_generate)"),
      state: z.string().optional().describe("Filter by state: pending | running | completed | partially_failed | failed | cancelled"),
      limit: z.number().int().min(1).max(100).optional().default(20),
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ kind, state, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (state) params.set("state", state);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/operations${qs}`);
      const rawOps = (data?.operations ?? (Array.isArray(data) ? data : [])) as Record<string, unknown>[];
      const result = { count: rawOps.length, detail, operations: projectList(detail, rawOps, opProjector) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Get job (generic async poller) ────────────────────────────────────────
  server.tool(
    "get_job",
    [
      "To check whether ONE specific operation you started is finished, pending, or failed, call this with its operationId (the `pollUrl` param accepts a bare operationId + brandId). Do NOT use list_operations to check a specific op.",
      "Poll the status of any background Operation by its operationId or pollUrl.",
      "Returns the Operation row: { id, kind, state (pending|running|completed|partially_failed|failed|cancelled), brandId, scopeType, scopeId, progress, result, errors, startedAt, finishedAt, createdAt, updatedAt }.",
      "Call repeatedly until state is 'completed' or 'failed' (or 'cancelled'). When completed, the payload you want is in `result`; on failure, see `errors`.",
      "Pass wait:true to block until the job is done (polls every 3s, up to ~2 min) — preferred over calling repeatedly.",
      "Most generate_* and vibe_edit_* tools (including seo_generate_clusters and seo_generate_keywords) return an operationId — use this to poll them.",
      "Supports detail param: short=id+kind+state+progress, medium=adds timestamps+resultRef (key IDs from result, no full payload), full=raw including complete result JSONB.",
    ].join(" "),
    {
      pollUrl: z
        .string()
        .describe(
          "Full poll URL returned by an async tool, OR a bare operationId (plus brandId param)."
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Block and poll until the job reaches a terminal state (completed/failed/partially_failed/cancelled) or the wait window elapses. Polls every 3s. Use this instead of calling get_job repeatedly yourself."
        ),
      maxWaitSeconds: z
        .number()
        .int()
        .min(5)
        .max(280)
        .optional()
        .describe("Wait-window cap in seconds (default ~120s). Only applies when wait=true."),
      detail: detailParam("full"),
      brandId: z.string().optional().describe("Brand ID — required if pollUrl is a bare operationId"),
    },
    async ({ pollUrl, wait, maxWaitSeconds, detail, brandId }) => {
      // If it looks like a relative path or bare ID, build the URL from brand context.
      let url = pollUrl;
      if (!pollUrl.startsWith("http") && !pollUrl.startsWith("/")) {
        const id = requireBrandId(brandId);
        url = `/api/agent/v1/brands/${id}/operations/${pollUrl}`;
      } else if (pollUrl.startsWith("/")) {
        url = pollUrl;
      } else {
        // absolute URL — extract the path
        try {
          url = new URL(pollUrl).pathname + new URL(pollUrl).search;
        } catch {
          url = pollUrl;
        }
      }

      const projectJob = (dataRec: Record<string, unknown>): unknown => {
        const base = detail === "full"
          ? { ...dataRec, ...derivedJobFields(dataRec) }
          : project(detail, dataRec, jobProjector);
        // Surface an ETA only while the job is still running and the kind is known.
        if (base != null && typeof base === "object") {
          const { done } = derivedJobFields(dataRec);
          const eta = done ? null : etaFor(dataRec.kind as string | null | undefined);
          if (eta) return { ...(base as Record<string, unknown>), eta };
        }
        return base;
      };

      // ── Single-GET (default) ──────────────────────────────────────────────
      if (!wait) {
        const data = await api.get<any>(url);
        const dataRec = data as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(projectJob(dataRec)) }],
        };
      }

      // ── Blocking wait — poll until terminal or the window elapses ──────────
      const windowSeconds = maxWaitSeconds ?? Math.floor(config.pollTimeoutMs / 1000);
      const maxAttempts = Math.ceil((windowSeconds * 1000) / config.pollIntervalMs);
      const startedAt = Date.now();
      let dataRec: Record<string, unknown> = {};
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await api.get<any>(url);
        dataRec = data as Record<string, unknown>;
        if (derivedJobFields(dataRec).done) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(projectJob(dataRec)) }],
          };
        }
        if ((Date.now() - startedAt) / 1000 >= windowSeconds) break;
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
      }

      // Timeout — still running. Return the latest projection + a note (do not throw).
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const eta = etaFor(dataRec.kind as string | null | undefined);
      const note = eta
        ? `Still running after ${elapsed}s (this kind usually takes ${eta}). Call get_job again with wait:true to keep waiting.`
        : `Still running after ${elapsed}s. Call get_job again with wait:true to keep waiting.`;
      const latest = projectJob(dataRec);
      const withNote = latest != null && typeof latest === "object"
        ? { ...(latest as Record<string, unknown>), note }
        : { job: latest, note };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(withNote) }],
      };
    }
  );
}
