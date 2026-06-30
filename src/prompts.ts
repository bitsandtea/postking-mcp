import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer) {
  // ── Getting started ───────────────────────────────────────────────────────
  server.prompt(
    "getting_started",
    "Step-by-step guide for first-time PostKing setup",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Guide me through setting up PostKing for the first time.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Welcome to PostKing! Here's how to get set up:

**Step 1 — Log in or register**
- New user? I can call \`register\` with your email+password — PostKing sends a magic-link confirmation.
- Existing user via device code? I'll call \`login_start\` to get you a login link and finish with \`login_complete\`.

**Step 2 — Create or onboard a brand**
- If you have a website: I'll call \`onboard_brand\` with your URL. PostKing crawls it and auto-generates your brand profile + 10 content themes.
- Or I can call \`create_brand\` manually with a name, tone, and audience.

**Step 3 — Connect your social accounts**
I'll call \`check_social_accounts\` to see what's connected, then \`generate_connect_link\` to get you a secure link to connect LinkedIn, X, Instagram, Threads, or Facebook.

**Step 4 — Create your first post**
Choose a flow:
- **AI-generated**: \`generate_post\` with a platform → then \`approve_post\` to schedule it
- **Repurpose a URL**: \`repurpose_content\` with a URL → then \`create_post\` + \`approve_post\`
- **Write your own**: \`create_post\` directly with your content

Ready to start? I'll call \`login_start\` now.`,
          },
        },
      ],
    })
  );

  // ── Connect social accounts ───────────────────────────────────────────────
  server.prompt(
    "connect_social_accounts",
    "Guide for connecting or checking social media accounts",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me connect my social media accounts to PostKing.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Let me check what's already connected and get you set up.

**What I'll do:**
1. Call \`check_social_accounts\` — shows all connected and disconnected platforms for your active brand
2. Need to connect a specific platform? Call \`generate_connect_link\` with \`platform\` = linkedin | x | instagram | threads | facebook — returns a magic link that autostarts that platform's OAuth.
3. Or pass no platform to get a generic link to the dashboard connect page.
4. After connecting in the browser, I can call \`check_social_accounts\` again to confirm.

**Supported platforms:** X (Twitter), LinkedIn, Instagram, Threads, Facebook

Should I check your connected accounts now?`,
          },
        },
      ],
    })
  );

  // ── Repurpose and schedule ────────────────────────────────────────────────
  server.prompt(
    "repurpose_and_schedule",
    "Turn a URL or text into scheduled social posts",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me repurpose content and schedule it across my social accounts.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Here's the repurpose-to-schedule flow:

**Step 1 — Check connected platforms**
I'll call \`check_social_accounts\` so we know which platforms are available.

**Step 2 — Repurpose your content**
Call \`repurpose_content\` directly — do NOT fetch or read the URL yourself first, PostKing crawls it internally.
- \`sourceType\`: \`url\` (paste a link), \`text\` (paste copy), or \`social_post\` (existing post ID)
- \`targetPlatforms\`: e.g. \`["linkedin", "x"]\`
- Optional: \`angle\` to steer the angle, \`voiceProfileIds\` to match your voice

**Step 3 — Save as a draft**
Call \`create_post\` with the generated content and your target platforms.

**Step 4 — Schedule it**
Call \`approve_post\` with the post ID and a future datetime (ISO 8601 UTC), e.g. \`2026-03-12T09:00:00Z\`.

**Step 5 — Confirm**
Call \`get_calendar\` to see it in your schedule.

What content do you want to repurpose? Give me a URL or paste your text.`,
          },
        },
      ],
    })
  );

  // ── Manage scheduled posts ────────────────────────────────────────────────
  server.prompt(
    "manage_posts",
    "View, reschedule, or delete scheduled and draft posts",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me manage my scheduled and draft posts.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Here's what I can do with your posts:

**View posts**
- \`list_posts\` — filter by status (\`created\` = drafts, \`scheduled\`, \`posted\`) and platform
- \`get_calendar\` — see everything scheduled in the next N days
- \`get_post\` — inspect a single post by ID

**Schedule a draft**
- \`approve_post\` — pick a post ID and a future datetime to lock it in

**Reschedule**
- \`reschedule_post\` — move a scheduled post to a new time

**Delete**
- \`delete_post\` — removes a post regardless of status (draft, scheduled, or posted)

Want me to pull up your current drafts or upcoming calendar?`,
          },
        },
      ],
    })
  );

  // ── Content themes ────────────────────────────────────────────────────────
  server.prompt(
    "manage_themes",
    "View, edit, or generate content themes for your brand",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me set up content themes for my brand.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Content themes tell PostKing what to write about when generating posts.

**View existing themes**
\`list_themes\` — shows all themes with IDs, titles, and instructions.

**Generate new themes with AI**
\`generate_themes\` — specify a count (1–20) and optional instructions like "focus on startup growth tips". Uses credits.

**Edit a theme**
\`edit_theme\` — update the title or content instructions for any theme by ID.

**Delete a theme**
\`delete_theme\` — remove a theme you no longer need.

**Using themes when generating posts**
Pass a \`theme\` ID to \`generate_post\` or \`repurpose_content\` to steer the content direction.

Want me to show your current themes?`,
          },
        },
      ],
    })
  );

  // ── Blog publishing ───────────────────────────────────────────────────────
  server.prompt(
    "blog_publishing",
    "Generate, edit, and publish blog posts to WordPress, Medium, Substack and more",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me create and publish a blog post with PostKing.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `PostKing has full blog publishing — here's the flow:

**Step 1 — Set up a publication (once)**
\`list_blogs\` — shows your existing publications and articles.
If you don't have one: \`create_publication\` with a title. Returns a publication ID.

**Step 2 — Generate the article**
\`generate_blog_post\` with:
- \`publicationId\` — from step 1
- \`topic\` — what to write about
- \`voiceProfileId\` — optional, get IDs from \`list_voices\` to write in a specific style
- \`targetLength\`: short | medium | long
- \`primaryKeywords\` — for SEO targeting

**Step 3 — Review & edit**
\`get_blog_article\` — shows the full content (first 2000 chars).
\`update_blog_article\` — edit title, content, excerpt, or SEO fields.

**Step 4 — Publish**
Two options:
- **PostKing hosted blog**: \`update_blog_article\` with \`status: "published"\` — goes live on your PostKing domain
- **External platforms** (WordPress, Medium, Substack, etc.):
  1. \`list_publishing_connections\` — see what's connected
  2. \`publish_blog_article\` with the article ID and connection IDs

**Import existing content**
\`import_blog_articles\` — pull in posts from an existing blog URL or RSS feed as drafts.

What would you like to write about?`,
          },
        },
      ],
    })
  );

  // ── Voice profiles ────────────────────────────────────────────────────────
  server.prompt(
    "use_voice_profiles",
    "Apply a voice profile to rewrite or generate content in a specific style",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `How do I use voice profiles in PostKing?`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Voice profiles let you write in a specific person's style.

**List available voices**
\`list_voices\` — shows all active voice profiles with their IDs and authors.

**Rewrite existing text with a voice**
\`rewrite_with_voice\` — pass a voice profile ID, your text, and optionally a platform. Returns the rewritten version.

**Generate posts in a voice**
Pass \`voice\` (profile ID) to \`generate_post\`, or \`voiceProfileIds\` to \`repurpose_content\`.
For per-platform voices in repurpose: \`["x:profileId1", "linkedin:profileId2"]\`

Want me to list the available voices now?`,
          },
        },
      ],
    })
  );

  // ── SEO end-to-end ────────────────────────────────────────────────────────
  server.prompt(
    "seo_end_to_end",
    "Run SEO / GEO from seed keywords to published articles using PostKing's agentic SEO / GEO pipeline",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Run the full PostKing SEO / GEO pipeline for my active brand.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `I'll drive the 11-step SEO / GEO agentic flow end-to-end — producing content optimized both for classic search ranking and for citation by AI assistants (Claude / ChatGPT / Perplexity) via definition-first H2s, FAQ schema, and source-attributable claims.

**Step 1 — Seed** (\`seo_add_seeds\`)
Tell me 3–10 seed topics and I'll register them.

**Step 2 — Expand** (\`seo_generate_keywords\`)
Default 100 keywords. Costs credits.

**Step 3 — Categorize & Cluster** (\`seo_categorize\` then \`seo_generate_clusters\`)
Tags by intent and groups into topic pillars.

**Step 4 — Pick a pillar** (\`seo_list_clusters\`)
I'll show the clusters; you choose one (or I pick the highest-volume).

**Step 5 — Approve clusters** (\`seo_bulk_approve_clusters\`)
Brief generation only runs on approved clusters. Pass the chosen cluster IDs to \`seo_bulk_approve_clusters\` (or \`seo_approve_cluster\` for a single one). Approval kicks off an async \`seo_brief_generate\` Operation per cluster — poll each returned \`operationId\` via \`get_job\` until \`state\` is \`completed\`.

**Step 6 — Roadmap** (\`seo_generate_roadmap\`)
Turns the approved cluster(s) into ~20 prioritized blog topics — each topic gets a SeoBrief auto-drafted in the background.

**Step 7 — Review & approve briefs** (\`seo_list_briefs\` → \`seo_edit_brief\` → \`seo_approve_briefs\`)
List the generated briefs, inspect with \`seo_get_brief\`, refine the briefData JSON via \`seo_edit_brief\` (or rerun the whole brief with \`seo_regenerate_brief\`), then \`seo_approve_briefs\` with the brief IDs. Approval is the gate that unlocks article generation.

**Step 8 — Write** (\`seo_write_article\`)
Draft the top 5 articles from the approved briefs. Review each with \`get_blog_article\`.

**Step 9 — Audit & Publish**
- \`seo_gap\` + \`seo_competitor\` for a final audit.
- \`seo_publish_article\` with an optional \`scheduledAt\` to schedule.
- \`seo_roadmap_stats\` to confirm completion.

**Step 10 — Auto-assign CTAs (optional, post-publish)** (\`seo_auto_assign_cta\`)
After articles are live, batch-assign a published side-page CTA to each blog. Defaults skip blogs that already have a CTA and Webflow-synced blogs. Pass \`blogIds: "all"\` to process the entire brand. Returns per-blog results in one synchronous response — closes the SEO/GEO loop with a conversion-side step.

**Step 11 — Cluster-linked side pages (optional)** (\`seo_generate_side_page\`)
Generate a side page for one of the brand's landing pages and link it to a target SEO cluster via \`clusterId\`. The new side page inherits the cluster's keyword targeting and feeds the topic-authority signal that GEO citation patterns reward.

Tell me the seed keywords to start with.`,
          },
        },
      ],
    })
  );

  // ── Content week planner ──────────────────────────────────────────────────
  server.prompt(
    "content_week_planner",
    "Plan and approve a full week of social posts using smart-week + batch generation",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Plan my content for the next week across my connected platforms.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Here's the smart weekly-planning flow:

**Step 1 — Check platforms**
\`check_social_accounts\` — confirm what's connected.

**Step 2 — Generate a week plan**
\`smart_week\` (or \`generate_batch\`) — creates a themed, spaced-out schedule of drafts. I'll pick platform mix and posting times.

**Step 3 — Review drafts**
\`list_posts\` with \`status: created\` — pulls up what was generated.
\`get_post\` to inspect individual drafts.

**Step 4 — Batch-approve**
For each draft you like, call \`approve_post\` with a scheduled datetime. I'll stagger them across peak times.

**Step 5 — Confirm the calendar**
\`get_calendar\` to verify the final weekly schedule.

**Heads-up:** Each \`approve_post\` / \`post_now\` counts against your free-tier cap. If \`FREE_CAP_REACHED\` comes back, I'll surface the \`checkoutUrl\` so you can upgrade.

How many posts per day and which platforms?`,
          },
        },
      ],
    })
  );

  // ── Blog publishing pipeline ──────────────────────────────────────────────
  server.prompt(
    "blog_publishing_pipeline",
    "Generate a blog article, iterate via MCP resources, then publish to internal or external platforms",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me ship a blog article from prompt to published.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `The blog publishing pipeline:

**Step 1 — Pick or create a publication**
\`list_blogs\` to see publications, or \`create_publication\` to make one.

**Step 2 — Generate the draft**
\`generate_blog_post\` with publicationId, topic, optional voiceProfileId, targetLength, primaryKeywords.

**Step 3 — Review**
\`get_blog_article\` returns the first 3000 chars for inline review. Iterate with \`update_blog_article\` — edit title, content, SEO fields.

**Step 4 — Choose a publish target**
- **PostKing hosted blog**: \`update_blog_article\` with \`status: "published"\`. Free-tier choke point.
- **External (WordPress / Medium / Substack)**:
  1. \`list_publishing_connections\`
  2. \`publish_blog_article\` with connectionIds. Same choke point.

**Step 5 — Confirm**
\`get_blog_article\` again — status should be \`published\`.

What topic should I draft?`,
          },
        },
      ],
    })
  );

  // ── Landing page builder ──────────────────────────────────────────────────
  server.prompt(
    "landing_page_builder",
    "Generate a landing page, iterate with AI edits, connect a domain, then publish",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me build and publish a landing page.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `The landing-page builder flow:

**Step 1 — Generate**
\`create_landing_page\` with a topic + optional slug + voiceProfileId. Returns a slug.

**Step 2 — Iterate with AI edits**
\`update_landing_page\` with \`instructions\` — e.g. "tighten the hero, add a pricing section, make the CTA more urgent". Repeat until happy.

**Step 3 — Optional side-pages**
\`generate_side_page\` for feature pages, case studies, legal pages.

**Step 4 — Connect a custom domain**
\`add_domain\` → adds a DNS TXT record you add at your registrar → \`verify_domain\`.
Then \`connect_domain\` with \`target: lp:<slug>\`.

**Step 5 — Publish**
\`publish_landing_page\` — free-tier choke point. Returns the live URL.

What should the landing page be about?`,
          },
        },
      ],
    })
  );

  // ── Reddit repurpose flow ──────────────────────────────────────────────────
  server.prompt(
    "reddit_repurpose",
    "Repurpose brand content into Reddit-native posts: pool subreddits → suggest subreddits for content → rewrite → review",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `What can PostKing do with Reddit and how do I use it?`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `PostKing's Reddit module is a **repurpose-to-Reddit workflow** — it turns your existing content (blog articles, text) into Reddit-native posts tailored to specific subreddits. It is NOT a publishing "medium" like LinkedIn or X; Reddit posts are never scheduled through the normal post queue.

**How to reach it in the dashboard:** \`dashboard_link\` with section \`"reddit"\`.

**The 4-step flow:**

**Step 1 — Discover your brand's subreddits** (\`reddit_generate_pool\` → \`reddit_get_pool\`)
This is **brand-level subreddit discovery** — it analyzes the brand (no specific content needed) and produces a scored pool of subreddits where the brand would be relevant and welcome.
- \`reddit_generate_pool\` is async — returns \`{ operationId }\`. Poll \`get_job\` until \`state=completed\`. Only needed once per brand (or to refresh).
- \`reddit_get_pool\` returns the scored pool, sorted most-relevant first. **This already answers "which / what / top N subreddits should my brand post in?"** — pass \`top\` for a top-N list. NO content required.

**Step 2 — Place a SPECIFIC piece of content** (\`reddit_suggest\`)
This is the **content-level** step — use it only when you have a particular article/text and want the best subreddits FOR THAT CONTENT, each with multiple posting angles.
- Given a blog article (\`postId\`) or raw text (\`title + content\`), returns up to 8 subreddits from the pool.
- Synchronous, 0 credits. Returns \`{ suggestions: [{ subreddit, subscribers, posting_style, promotion_mode, buyer_intent, match_score, reason, rule_to_watch, angles: [{ angle_type, title, hook }] }] }\` — each suggestion carries 2-3 diverse angles.
- Not required just to see the brand's subreddits — for that, use \`reddit_get_pool\`. Use the \`subreddit\` field plus an angle's \`title\`/\`hook\` from a suggestion result in Step 3.

**Step 3 — Rewrite for the subreddit** (\`reddit_rewrite\`)
Rewrites your content as a Reddit-native post for the chosen subreddit, respecting its rules and culture.
- Params: \`subreddit\`, \`voiceId\` (from \`list_voices\`; pass \`"none"\` for no voice), \`sourcePostId\` or \`sourceContent\`.
- Async — returns \`{ jobId }\`. Poll \`get_job\` until \`state=completed\`.
- Up to 3 variations per call. Uses credits.

**Step 4 — Review saved posts** (\`reddit_list_posts\`)
Lists all saved Reddit post outputs. Each post's \`outputData\` has \`redditTitle\`, \`body\`, \`notes\`, \`subreddit\`, \`angle\`.

**Helper:** \`reddit_global_pool\` — shows how many subreddits are in PostKing's global dataset (informational only).

What content do you want to repurpose for Reddit?`,
          },
        },
      ],
    })
  );

  // ── Plan a storyline campaign ─────────────────────────────────────────────
  server.prompt(
    "plan_storyline_campaign",
    "Plan and execute a full marketing storyline: clarify → brief → strategy → curate → execute",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me plan and execute a marketing campaign using PostKing storylines.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `I'll drive the full storyline campaign lifecycle — from intent to published drafts.

**Step 1 — Create the storyline** (\`storyline_create\`)
Describe your campaign goal (e.g. "Q3 product launch targeting SMBs"). I'll create the storyline record.

**Step 2 — Clarify** (\`storyline_clarify\` — loop)
The system asks follow-up questions to gather positioning, audience, timing, and tone context. Call iteratively until it signals readiness.

**Step 3 — Generate the brief** (\`storyline_generate_brief\` → poll \`get_job\`)
Async (~1–3 min). Produces positioning, key messages, audience, timing, proof points, dos/don'ts. Poll \`get_job\` until \`state=completed\`, then review with \`storyline_get\` (full detail).

**Step 4 — Refine the brief** (\`storyline_edit_brief\`)
Natural-language AI edit — e.g. "tighten the key messages, add a proof point about enterprise customers".

**Step 5 — Confirm** (\`storyline_confirm_brief\`)
Locks the brief and gates strategy generation.

**Step 6 — Generate strategy** (\`storyline_generate_strategy\` → poll \`get_job\`)
Async (~2–5 min). Produces a full set of line items (content pieces across channels). Poll \`get_job\`, then review with \`storyline_get_strategy\`.

**Step 7 — Curate line items**
- \`storyline_add_line_item\` — add a channel/type/title
- \`storyline_update_line_item\` — edit any field
- \`storyline_delete_line_item\` — remove (confirm: true)
- \`storyline_regenerate_line_item\` — async regenerate a single item (poll \`get_job\`)

**Step 8 — Estimate** (\`storyline_estimate\`)
Dry-run: how many credits will execution cost?

**Step 9 — Execute** (\`storyline_execute\` → poll \`get_job\`)
Async (~3–8 min). Generates all selected drafts. Poll \`get_job\` until \`state=completed\`, then use \`list_posts\` / \`list_blogs\` to review the output.

What campaign would you like to plan?`,
          },
        },
      ],
    })
  );

  // ── Competitor intelligence ───────────────────────────────────────────────
  server.prompt(
    "competitor_intelligence",
    "Build a competitive intelligence picture: probe → add → analyze → comparison → overview",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me build competitive intelligence for my brand in PostKing.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Here's the competitive intelligence workflow — from discovery to landscape overview.

**Step 1 — Discover rival domains** (\`competitor_probe\` → \`competitor_probe_status\`)
PostKing crawls and surfaces rival domains based on your brand. \`competitor_probe\` returns \`{ started: true }\` — poll \`competitor_probe_status\` until status=completed, then review the candidates list.

**Step 2 — Classify candidates** (\`competitor_probe_classify\` — loop per candidate)
For each candidate, classify as \`direct\`, \`similar\`, or \`not_relevant\`. Skip this step to add domains directly.

**Step 3 — Add competitors** (\`competitor_add\` → poll \`get_job\`)
Async (~2–5 min per batch). Pass up to 20 domains. Each triggers crawl + profile analysis.

**Step 4 — Analyze pending rows** (\`competitor_analyze\` → poll \`get_job\`)
Re-run analysis on any pending or failed competitor rows.

**Step 5 — Review the list** (\`competitor_list\`)
Check status, analysis state, and exclusion flags. Use \`competitor_update\` to toggle \`excludeFromSeoPull\` or \`competitor_delete\` to remove one.

**Step 6 — Head-to-head comparison** (\`competitor_get_comparison\` / \`competitor_recompute_comparison\`)
\`competitor_get_comparison\` returns the saved comparison. After adding new competitors, call \`competitor_recompute_comparison\` to refresh.

**Step 7 — Landscape overview** (\`competitor_get_overview\` / \`competitor_generate_overview\` → poll \`get_job\`)
\`competitor_get_overview\` returns the cached overview. \`competitor_generate_overview\` is async (~2–5 min) and produces a fresh AI-synthesized landscape summary.

**Bonus** — \`competitor_comparison_sources\`: see which SEO sources feed the comparison.

Which brand do you want to analyze competitors for?`,
          },
        },
      ],
    })
  );

  // ── Manage knowledge base ─────────────────────────────────────────────────
  server.prompt(
    "manage_knowledge_base",
    "Browse, create, update, and delete brand knowledge base items",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me manage my brand's knowledge base in PostKing.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `The knowledge base stores structured brand facts — product details, positioning, FAQs, personas, and more — that PostKing uses when generating content.

**Step 1 — Browse** (\`knowledge_list\`, short detail)
Lists all active items with ID, name, and content type. Filter by \`tag\`, \`global\`, or \`activeOnly\`.

**Step 2 — Inspect** (\`knowledge_get\`, full detail)
Fetch the full content and metadata for a single item.

**Step 3 — Create** (\`knowledge_create\` → poll \`get_job\`)
Async (~15–30 s). Pass \`name\`, \`content\` (text or JSON string), \`contentType\` (text/json), optional \`description\` and \`tags[]\`. Set \`isGlobal: true\` to share across all brands on the account. Poll \`get_job\` until \`state=completed\`.

**Step 4 — Update** (\`knowledge_update\`)
Edit name, description, content, or tags for an existing item. Minor updates are sync; large content changes may queue a background enrichment job.

**Step 5 — Retire** (\`knowledge_delete\`)
Soft-deletes the item — it no longer appears in lists but is not permanently destroyed.

What knowledge would you like to add or manage?`,
          },
        },
      ],
    })
  );

  // ── Trends to post ────────────────────────────────────────────────────────
  server.prompt(
    "trends_to_post",
    "Browse trending posts, extract or pick a content template, then generate a post",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me turn trending content into a post for my brand using PostKing.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Here's how to go from trending insights to a finished post.

**Step 1 — Browse the trend feed** (\`trends_list\`)
Account-scoped (no brand required). Filter by \`niche\`, \`platform\` (linkedin, x, instagram, threads), \`days\` (1–30), \`limit\`, and \`sort\` (recency | engagement). Returns trending posts with optional deconstruction data.

**Step 2a — Extract a template from a trending post** (\`template_extract\`)
Paste the post text and let PostKing AI deconstruct the underlying content pattern (hook, structure, CTA, format). Pass \`save: true\` to persist it as a template for reuse.

**Step 2b — OR pick the best-fit template** (\`template_list\` then \`template_pick\`)
\`template_list\` shows your saved templates. \`template_pick\` takes a theme or brief and AI-scores your existing templates to find the best match.

**Step 3 — Save the template** (\`template_create\`)
Persist a template with \`title\`, \`body\` (the post structure with placeholders), \`category\`, and optional \`platforms\` (array) and \`pattern\` (plain-language description of the structure). Update later with \`template_update\` or \`template_delete\`.

**Step 4 — Generate a post**
Use \`generate_post\` or \`repurpose_content\` with your chosen angle. Reference the template pattern in your instructions to guide the AI.

What niche or platform do you want to pull trends from?`,
          },
        },
      ],
    })
  );

  // ── Repurpose & schedule (v0.1 update — registered under a distinct name) ──
  server.prompt(
    "repurpose_and_schedule_v2",
    "Updated repurpose flow for /api/agent/v1/* endpoints with per-platform voice profiles",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Repurpose a URL or text into scheduled social posts (v2).`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `Updated repurpose flow:

1. \`check_social_accounts\` — confirm platforms.
2. \`repurpose_content\` with \`sourceType\`, \`targetPlatforms\`, optional \`voiceProfileIds\` (per-platform map supported).
3. \`create_post\` with the generated content.
4. \`approve_post\` with a future \`scheduledAt\` (ISO 8601 UTC). Free-tier choke point.
5. \`get_calendar\` to confirm.

Give me a URL or text to start.`,
          },
        },
      ],
    })
  );
}
