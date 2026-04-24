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
    "Run SEO from seed keywords to published articles using PostKing's agentic SEO pipeline",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Run the full PostKing SEO pipeline for my active brand.`,
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: `I'll drive the 7-step SEO agentic flow end-to-end:

**Step 1 — Seed** (\`seo_add_seeds\`)
Tell me 3–10 seed topics and I'll register them.

**Step 2 — Expand** (\`seo_generate_keywords\`)
Default 100 keywords. Costs credits.

**Step 3 — Categorize & Cluster** (\`seo_categorize\` then \`seo_cluster\`)
Tags by intent and groups into topic pillars.

**Step 4 — Pick a pillar** (\`seo_list_clusters\`)
I'll show the clusters; you choose one (or I pick the highest-volume).

**Step 5 — Roadmap** (\`seo_generate_roadmap\`)
Turns the chosen cluster into ~20 prioritized blog topics.

**Step 6 — Write** (\`seo_write_article\`)
Draft the top 5 articles. Review each with \`get_blog_article\`.

**Step 7 — Audit & Publish**
- \`seo_gap_analysis\` + \`seo_competitor_diff\` for a final audit.
- \`seo_publish_article\` with an optional \`scheduledAt\` to schedule.
- \`seo_roadmap_stats\` to confirm completion.

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
