import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, api } from "../client.js";
import { requireBrandId } from "../state.js";
import { brandDashboardUrl } from "../links.js";

/**
 * Deep AI Dive (AI visibility probe) — the WRITE side. `search_ai_visibility`
 * (search-performance.ts) reads the results; these tools start a run, poll it,
 * and manage which topics a run asks about. All proxy
 * `/api/agent/v1/brands/{id}/search-performance/ai-visibility/{run,run-status,topics}`,
 * which wrap the dashboard routes — tier gate, monthly limit and spawn logic
 * stay server-side.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** Refusal tokens the run route puts at the start of a 409 message. */
const RUN_REFUSAL_HINTS: Record<string, string> = {
  running:
    "A probe run, or the background question drafting started by ai_visibility_topic_include, is still in progress for this brand. Poll ai_visibility_run_status until it settles, then call ai_visibility_run again.",
  no_config:
    "No probe config exists yet (no topics/questions have been saved). Set up the Deep AI Dive once in the dashboard (Search performance > AI mentions), then run again.",
  monthly_limit: "This brand already used its one manual Deep AI Dive run for this calendar month. It resets next month.",
};

export function registerAiVisibilityProbeTools(server: McpServer) {
  // ── ai_visibility_run ────────────────────────────────────────────────
  server.tool(
    "ai_visibility_run",
    [
      "Start a Deep AI Dive run: asks every enabled AI answer engine (ChatGPT, Perplexity, Google AI Overview, Claude) every saved question for the brand's SAVED topics and scores brand mentions/citations vs. competitors.",
      "COSTS REAL MONEY: each run makes paid engine/Apify calls and charges credits, so only call it when the user clearly wants a fresh run. Capped at ONE manual run per calendar month per brand, one run at a time, and requires PRO or Enterprise.",
      "Runs the brand's existing saved config only (ai_visibility_topics_list shows what that includes: topics with selected=true); it needs the Deep AI Dive to have been set up once in the dashboard. A topic added with ai_visibility_topic_add is NOT part of the run until ai_visibility_topic_include has finished drafting its questions; the response warns if any custom topic is left out.",
      "Returns immediately with { started: true, runsStarted }; the run takes a few minutes — poll ai_visibility_run_status, then read results with search_ai_visibility.",
      "Refusals come back as { started: false, refusal, message } (not an error): refusal is one of tier_upgrade_required, running, no_config, monthly_limit.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      try {
        const notIncluded = await customTopicsNotInRun(id);
        const data = await api.post<Record<string, unknown>>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility/run`);
        return json({
          started: true,
          runsStarted: data?.runsStarted ?? null,
          ...(notIncluded.length > 0
            ? {
                warning: `These custom topics are in the menu but NOT in this run (call ai_visibility_topic_include, wait for it, then run again): ${notIncluded.join(", ")}.`,
                topicsNotInRun: notIncluded,
              }
            : {}),
          next: "Poll ai_visibility_run_status; read results with search_ai_visibility once completed.",
          dashboardUrl: brandDashboardUrl(id, "search_performance"),
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const token = Object.keys(RUN_REFUSAL_HINTS).find((t) => err.message.startsWith(`${t}:`)) ?? "refused";
          return json({ started: false, refusal: token, message: RUN_REFUSAL_HINTS[token] ?? err.message });
        }
        if (err instanceof ApiError && err.status === 403) {
          return json({
            started: false,
            refusal: "tier_upgrade_required",
            message: `${err.message} Upgrade the plan to PRO or Enterprise to run it.`,
          });
        }
        throw err;
      }
    }
  );

  // ── ai_visibility_run_status ─────────────────────────────────────────
  server.tool(
    "ai_visibility_run_status",
    [
      "Status of the brand's Deep AI Dive run. Free read. operationStatus.status is pending | processing | completed | failed; while processing, progress = {current, total} landed (engine, market) slots plus a plain-language message.",
      "A brand with nothing running (never ran, or finished long ago) reads as failed with an error starting 'No check' — that means idle, not broken. Any other failed error is a real failure. Poll every ~15-30s; a run usually takes a few minutes and is considered failed after 3 hours.",
      "When completed, read the results with search_ai_visibility.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<{ operationStatus?: { status?: string; error?: string } }>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility/run-status`);
      const st = data?.operationStatus;
      const idle = st?.status === "failed" && typeof st.error === "string" && st.error.startsWith("No check");
      return json({ ...data, idle, dashboardUrl: brandDashboardUrl(id, "search_performance") });
    }
  );

  // ── ai_visibility_topics_list ────────────────────────────────────────
  server.tool(
    "ai_visibility_topics_list",
    [
      "List the brand's Deep AI Dive probe topics (offerings the AI engines are asked about). Free, read-only; never derives new topics.",
      "Returns topics[] (id, label, description, selected) — `selected` means the topic is in the saved config and WILL be asked in the next run — plus questionsPerTopic, runs and marketKeys. Custom topics have ids starting 'custom-'.",
      "Also returns `inProgress` (a probe run or topic drafting is running right now) and `lastError` (a failed drafting/run reason, if any). Use the ids with ai_visibility_topic_include / ai_visibility_topic_remove. Topics added with ai_visibility_topic_add show selected=false until ai_visibility_topic_include has drafted their questions; after calling it, poll this tool until they flip to selected=true.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<{ topics?: TopicsDto }>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility/topics`);
      const busy = await busyState(id);
      return json({ ...shapeTopics(data?.topics, id), ...busy });
    }
  );

  // ── ai_visibility_topic_add ──────────────────────────────────────────
  server.tool(
    "ai_visibility_topic_add",
    [
      "Add a custom topic (a free-text offering such as \"Pet insurance for senior dogs\") to the brand's Deep AI Dive topic menu. Requires PRO+. Free and instant — it does not start a run or draft questions.",
      "Limits: label 2-80 characters, description up to 200 (defaults to the label), max 10 custom topics per brand.",
      "This only adds the topic to the menu (selected=false), so the next run will NOT ask about it yet. To put it into the next run, call ai_visibility_topic_include afterwards (add every topic first, then include them all in one call).",
    ].join(" "),
    {
      label: z.string().min(2).max(80).describe("Topic / offering name, 2-80 characters."),
      description: z.string().max(200).optional().describe("One line on what counts as on-topic (max 200). Defaults to the label."),
      brandId: brandOpt,
    },
    async ({ label, description, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<{ topics?: TopicsDto; addedTopicId?: string }>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility/topics`, {
        label,
        ...(description ? { description } : {}),
      });
      return json({
        added: true,
        addedTopicId: data?.addedTopicId ?? null,
        note: "Added to the topic menu only (selected=false). Call ai_visibility_topic_include with addedTopicId to put it into the next run.",
        ...shapeTopics(data?.topics, id),
      });
    }
  );

  // ── ai_visibility_topic_include ──────────────────────────────────────
  server.tool(
    "ai_visibility_topic_include",
    [
      "Put topics from the menu into the NEXT Deep AI Dive run: drafts questions for ONLY the given topics and appends them to the saved config. Existing topics, their questions (including edits) and the markets are left untouched. Does NOT start a run.",
      "COSTS PLATFORM LLM SPEND (a few Claude calls per topic) and takes a minute or more, so it returns immediately with questionsPending:true and drafts in the background. While it works, a probe run is refused as 'running'. Poll ai_visibility_topics_list until the ids show selected=true (or ai_visibility_run_status shows an error if drafting failed), then call ai_visibility_run.",
      "Typical flow for 'add 2 topics and rerun': ai_visibility_topic_add x2, then ONE ai_visibility_topic_include with both ids (they are drafted together; a second call while the first is drafting is refused), wait, then ai_visibility_run.",
      "Requires PRO+ and an existing saved config. Refusals return { included: false, refusal } with refusal one of tier_upgrade_required, running, no_config (set up the Deep AI Dive once in the dashboard first) or unknown_topic.",
    ].join(" "),
    {
      topicIds: z.array(z.string().min(1)).min(1).max(10).describe("Topic ids from ai_visibility_topics_list or ai_visibility_topic_add's addedTopicId. Max 10 per call."),
      brandId: brandOpt,
    },
    async ({ topicIds, brandId }) => {
      const id = requireBrandId(brandId);
      try {
        const data = await api.post<{ started?: string[]; alreadyIncluded?: string[]; questionsPending?: boolean }>(
          `/api/agent/v1/brands/${id}/search-performance/ai-visibility/topics/include`,
          { topicIds }
        );
        return json({
          included: true,
          started: data?.started ?? [],
          alreadyIncluded: data?.alreadyIncluded ?? [],
          questionsPending: data?.questionsPending ?? false,
          next: data?.questionsPending
            ? "Poll ai_visibility_topics_list until these ids show selected=true, then call ai_visibility_run."
            : "Nothing to draft; these topics are already in the next run.",
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const token = ["no_config", "running"].find((t) => err.message.startsWith(`${t}:`)) ?? "refused";
          return json({ included: false, refusal: token, message: err.message });
        }
        if (err instanceof ApiError && err.status === 404) return json({ included: false, refusal: "unknown_topic", message: err.message });
        if (err instanceof ApiError && err.status === 403) {
          return json({ included: false, refusal: "tier_upgrade_required", message: `${err.message} Upgrade the plan to PRO or Enterprise.` });
        }
        throw err;
      }
    }
  );

  // ── ai_visibility_topic_remove ───────────────────────────────────────
  server.tool(
    "ai_visibility_topic_remove",
    [
      "Remove a topic from FUTURE Deep AI Dive runs. Past run results, answers and citations are NOT deleted — history and trends stay intact. Free and instant, no run is started.",
      "Drops the topic from the saved selection; a custom topic ('custom-…') is also deleted from the menu, while a derived topic stays listed (selected=false) and can be re-selected later in the dashboard.",
      "Refused with { removed: false, message } when a run is in progress, when it is the only topic left in the selection (a run needs at least one), or when topicId is unknown. Get ids from ai_visibility_topics_list.",
    ].join(" "),
    {
      topicId: z.string().min(1).describe("Topic id from ai_visibility_topics_list (e.g. 'custom-pet-insurance' or a derived id)."),
      brandId: brandOpt,
    },
    async ({ topicId, brandId }) => {
      const id = requireBrandId(brandId);
      try {
        const data = await api.delete<{ topics?: TopicsDto; removedFromRuns?: boolean; removedFromMenu?: boolean }>(
          `/api/agent/v1/brands/${id}/search-performance/ai-visibility/topics/${encodeURIComponent(topicId)}`
        );
        return json({
          removed: true,
          removedFromRuns: data?.removedFromRuns ?? false,
          removedFromMenu: data?.removedFromMenu ?? false,
          ...shapeTopics(data?.topics, id),
        });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          return json({ removed: false, message: err.message });
        }
        throw err;
      }
    }
  );
}

/** Custom topics sitting in the menu that the next run will not ask about. Best effort: a failed read never blocks a run. */
async function customTopicsNotInRun(id: string): Promise<string[]> {
  try {
    const data = await api.get<{ topics?: TopicsDto }>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility/topics`);
    return shapeTopics(data?.topics, id)
      .topics.filter((t) => t.custom && !t.selected)
      .map((t) => t.id);
  } catch {
    return [];
  }
}

/** Whether a probe run / topic drafting is running, and the last failure reason. Best effort. */
async function busyState(id: string): Promise<{ inProgress?: boolean; lastError?: string }> {
  try {
    const data = await api.get<{ operationStatus?: { status?: string; error?: string } }>(
      `/api/agent/v1/brands/${id}/search-performance/ai-visibility/run-status`
    );
    const st = data?.operationStatus;
    const inProgress = st?.status === "pending" || st?.status === "processing";
    const realError = st?.status === "failed" && st.error && !st.error.startsWith("No check") ? st.error : undefined;
    return { inProgress, ...(realError ? { lastError: realError } : {}) };
  } catch {
    return {};
  }
}

interface TopicsDto {
  candidates?: { id: string; label: string; description: string }[];
  selectedTopicIds?: string[];
  questionsPerTopic?: number;
  runs?: number;
  marketKeys?: string[];
}

function shapeTopics(topics: TopicsDto | undefined, brandId: string) {
  const selected = new Set(topics?.selectedTopicIds ?? []);
  return {
    topics: (topics?.candidates ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      selected: selected.has(c.id),
      custom: c.id.startsWith("custom-"),
    })),
    selectedCount: selected.size,
    questionsPerTopic: topics?.questionsPerTopic ?? null,
    runs: topics?.runs ?? null,
    marketKeys: topics?.marketKeys ?? [],
    dashboardUrl: brandDashboardUrl(brandId, "search_performance"),
  };
}
