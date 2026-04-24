import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

export function registerJobTools(server: McpServer) {
  // ── List jobs ─────────────────────────────────────────────────────────────
  server.tool(
    "list_jobs",
    [
      "List background jobs for the active brand.",
      "Use status='pending' to see in-flight ops, 'completed' to see finished ones.",
      "Use get_job with an operationId to poll a specific job — most async tools return an operationId.",
    ].join(" "),
    {
      status: z
        .enum(["pending", "running", "completed", "failed"])
        .optional()
        .describe("Filter by job status"),
      limit: z.number().int().min(1).max(100).optional().default(20),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/jobs${qs}`);
      const jobs = (data?.jobs ?? []).map((j: any) => ({
        id: j.id,
        title: j.title,
        status: j.status,
        createdAt: j.createdAt,
        pollUrl: j.pollUrl,
        successRedirectUrl: j.successRedirectUrl ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }],
      };
    }
  );

  // ── Get job (generic async poller) ────────────────────────────────────────
  server.tool(
    "get_job",
    [
      "Poll the status of any background operation by its operationId or pollUrl.",
      "Returns status (pending|running|completed|failed) and any result payload.",
      "Call repeatedly until status is 'completed' or 'failed'.",
      "Most generate_* and vibe_edit_* tools return an operationId — use this to poll them.",
    ].join(" "),
    {
      pollUrl: z
        .string()
        .describe(
          "Full poll URL returned by an async tool (e.g. the pollUrl from generate_landing_page), OR a bare operationId"
        ),
      brandId: z.string().optional().describe("Brand ID — required if pollUrl is a bare operationId"),
    },
    async ({ pollUrl, brandId }) => {
      // If it looks like a relative path or bare ID, build the URL from brand context.
      let url = pollUrl;
      if (!pollUrl.startsWith("http") && !pollUrl.startsWith("/")) {
        const id = requireBrandId(brandId);
        url = `/api/agent/v1/brands/${id}/jobs/${pollUrl}`;
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
      const data = await api.get<any>(url);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
