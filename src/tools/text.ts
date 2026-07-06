import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { config } from "../config.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, truncate, type Projector } from "../detail.js";
import { derivedJobFields } from "./jobs.js";

const textProjector: Projector<Record<string, unknown>> = {
  short: (result) => ({ status: "completed", wordCount: result.wordCount }),
  medium: (result) => ({
    content: truncate(result.content, 500),
    wordCount: result.wordCount,
  }),
};

export function registerTextTools(server: McpServer) {
  server.tool(
    "generate_text",
    [
      "Generate or rewrite general-purpose, email-style/formal text — follow-up emails, cover letters, outreach messages, formal notes, etc. Polls until complete.",
      "This is NOT for social media posts — use generate_post for those.",
      "This is also NOT for a simple voice-only rewrite of existing text with no other options — for that, use rewrite_with_voice or rewrite_text instead. Reach for generate_text when you need mode selection (generate vs rewrite), a stated purpose, a target length, or when there's no source text at all (mode='generate').",
      "mode='generate' writes new text from a `prompt` (what to write, e.g. 'a follow-up email after a sales call, polite but direct'). mode='rewrite' rewrites existing `sourceText` into a new form/tone.",
      "`purpose` is optional free text describing the goal, e.g. 'win-back email' or 'job application cover letter'.",
      "`length` can be short | medium | long, or a specific target word count (20-5000).",
      "Supports detail param: short=status+wordCount only, medium=truncated content (500 chars)+wordCount (default), full=raw result including content, aiDetectionScore, burstinessScore, promptLogId, wordCount.",
    ].join(" "),
    {
      mode: z.enum(["generate", "rewrite"]).describe("generate = write new text from a prompt; rewrite = rework existing sourceText"),
      prompt: z
        .string()
        .max(4000)
        .optional()
        .describe("What to write, required when mode='generate'. Max 4000 chars."),
      sourceText: z
        .string()
        .max(20000)
        .optional()
        .describe("Existing text to rewrite, required when mode='rewrite'. Max 20000 chars."),
      purpose: z
        .string()
        .max(200)
        .optional()
        .describe("Free-text goal of the text, e.g. 'win-back email', 'job application cover letter'. Max 200 chars."),
      length: z
        .union([z.enum(["short", "medium", "long"]), z.number().min(20).max(5000)])
        .optional()
        .describe("Target length: short | medium | long, or a specific target word count (20-5000)."),
      voiceProfileId: z.string().optional().describe("Voice profile ID to apply. Get IDs from list_voices."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("full"),
    },
    async ({ mode, prompt, sourceText, purpose, length, voiceProfileId, brandId, detail }) => {
      const id = requireBrandId(brandId);

      if (mode === "generate" && !prompt) {
        throw new Error("prompt is required when mode='generate'");
      }
      if (mode === "rewrite" && !sourceText) {
        throw new Error("sourceText is required when mode='rewrite'");
      }

      const created = await api.post<{ operationId: string; status?: string }>(
        `/api/agent/v1/brands/${id}/text/generate`,
        {
          mode,
          prompt,
          sourceText,
          purpose,
          length,
          voiceProfileId,
        }
      );
      const operationId = created.operationId;

      // Same block-and-poll mechanism as generate_post / comparison pages:
      // poll the generic operations endpoint and use derivedJobFields (shared
      // with get_job) to detect terminal state.
      const maxAttempts = Math.ceil(config.generatePollTimeoutMs / config.pollIntervalMs);
      let op: Record<string, unknown> = {};
      let timedOut = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
        op = await api.get<Record<string, unknown>>(
          `/api/agent/v1/brands/${id}/operations/${operationId}`
        );
        const { done, summary } = derivedJobFields(op);
        if (done) {
          if (String(op.state) !== "completed") {
            throw new Error(`Text generation ${summary}`);
          }
          break;
        }
        if (attempt === maxAttempts - 1) timedOut = true;
      }

      if (timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "still_generating",
                operationId,
                instruction:
                  "Generation is STILL RUNNING — it has NOT failed. Do NOT write the text yourself. Wait ~15s, then call get_job with this operationId (wait:true). Repeat until state is 'completed', then read the text from the operation's result.",
              }),
            },
          ],
        };
      }

      const result = (op.result && typeof op.result === "object" ? op.result : {}) as Record<string, unknown>;
      const projected = project(detail, result, textProjector);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(projected) }],
      };
    }
  );
}
