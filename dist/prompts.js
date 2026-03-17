export function registerPrompts(server) {
    // ── Getting started ───────────────────────────────────────────────────────
    server.prompt("getting_started", "Step-by-step guide for first-time PostKing setup", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Guide me through setting up PostKing for the first time.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
                    text: `Welcome to PostKing! Here's how to get set up:

**Step 1 — Log in**
I'll call \`login_start\` to get you a login link. You visit it in your browser, approve, then tell me "done" and I'll call \`login_complete\` to save your credentials.

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
    }));
    // ── Connect social accounts ───────────────────────────────────────────────
    server.prompt("connect_social_accounts", "Guide for connecting or checking social media accounts", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Help me connect my social media accounts to PostKing.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
                    text: `Let me check what's already connected and get you set up.

**What I'll do:**
1. Call \`check_social_accounts\` — shows all connected and disconnected platforms for your active brand
2. If you need to connect more: call \`generate_connect_link\` — gives you a secure link to open in your browser to complete OAuth for any platform
3. After connecting in the browser, I can call \`check_social_accounts\` again to confirm

**Supported platforms:** X (Twitter), LinkedIn, Instagram, Threads, Facebook

Should I check your connected accounts now?`,
                },
            },
        ],
    }));
    // ── Repurpose and schedule ────────────────────────────────────────────────
    server.prompt("repurpose_and_schedule", "Turn a URL or text into scheduled social posts", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Help me repurpose content and schedule it across my social accounts.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
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
    }));
    // ── Manage scheduled posts ────────────────────────────────────────────────
    server.prompt("manage_posts", "View, reschedule, or delete scheduled and draft posts", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Help me manage my scheduled and draft posts.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
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
    }));
    // ── Content themes ────────────────────────────────────────────────────────
    server.prompt("manage_themes", "View, edit, or generate content themes for your brand", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Help me set up content themes for my brand.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
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
    }));
    // ── Blog publishing ───────────────────────────────────────────────────────
    server.prompt("blog_publishing", "Generate, edit, and publish blog posts to WordPress, Medium, Substack and more", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Help me create and publish a blog post with PostKing.`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
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
    }));
    // ── Voice profiles ────────────────────────────────────────────────────────
    server.prompt("use_voice_profiles", "Apply a voice profile to rewrite or generate content in a specific style", {}, () => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `How do I use voice profiles in PostKing?`,
                },
            },
            {
                role: "assistant",
                content: {
                    type: "text",
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
    }));
}
//# sourceMappingURL=prompts.js.map