# PostKing MCP Server

[![npm version](https://img.shields.io/npm/v/postking-mcp)](https://www.npmjs.com/package/postking-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [PostKing](https://postking.app) — an AI-powered content platform for social media scheduling, blog publishing, and brand management.

Connect Claude (Desktop, Cursor, or any MCP client) to your PostKing account and manage your entire content operation through conversation — generate posts, schedule them, repurpose URLs into social content, write and publish blog articles, generate landing pages and side pages, run SEO / GEO research and drafting, manage your asset library and weekly posting schedule, handle domains and API keys, and more.

The server exposes **207 tools across 26 modules** — full parity with the `postking-cli`.

> **Transport note:** On the remote HTTP transport (`mcp.postking.app`), 203 tools are available. The 4 authentication tools (`login_start`, `login_complete`, `logout`, `whoami`) are omitted on that transport because it uses OAuth bearer tokens rather than device-code login. All other 203 tools are identical across both transports.

---

## Quick start

### Claude Desktop

**Option A — Via the GUI:**

1. Open Claude Desktop → **Settings** (gear icon) → **Developer** → **Edit Config**
2. This opens `claude_desktop_config.json` in your default editor
3. Paste the following and save:

```json
{
  "mcpServers": {
    "postking": {
      "command": "npx",
      "args": ["-y", "postking-mcp"]
    }
  }
}
```

4. Restart Claude Desktop

**Option B — Edit the config file directly:**

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) in any text editor, paste the same JSON above, and save.

Once restarted, tell Claude: **"Login to PostKing"**

### Claude Code (CLI)

```bash
claude mcp add postking -- npx -y postking-mcp
```

### Hermes

```bash
npm i -g postking-mcp
hermes mcp add postking --command postking-mcp
```

Then in Hermes: **"Login to PostKing"**.

### Cursor / other MCP clients

Use the same `npx -y postking-mcp` command in your client's MCP server config.

---

## Login flow

No API keys to copy. PostKing uses a device login flow:

1. Tell Claude: **"Login to PostKing"**
2. Claude calls `login_start` → shows a URL and short code
3. Visit the URL in your browser, log in, approve
4. Tell Claude: **"Done"**
5. Claude calls `login_complete` → saves your token to `~/.postking/credentials.json`

You never need to log in again. The token is permanent.

---

## What you can do

### Authentication
_Available on stdio/local transport only. Remote HTTP transport authenticates via OAuth bearer token before the session is created._

| Tool | Description |
|------|-------------|
| `login_start` | Begin device login — get a URL and code to approve in browser |
| `login_complete` | Finish login and save token after browser approval |
| `logout` | Clear locally stored credentials |
| `whoami` | Return the profile of the currently authenticated user (email, plan, credit balance) |

### Brands
| Tool | Description |
|------|-------------|
| `list_brands` | List all brands on your account |
| `set_active_brand` | Set the default brand for this session |
| `get_brand_info` | View brand profile — tone, audience, themes |
| `create_brand` | Create a brand manually (step 1 of manual onboarding) |
| `onboard_brand` | Crawl a website and auto-generate a brand profile + 10 themes (step 1 of website onboarding) |
| `set_brand_mediums` | Save the list of platforms the brand publishes on (step 2 of onboarding) |
| `get_brand_mediums` | Read which publishing platforms a brand posts to |
| `get_onboarding_status` | Poll background audience analysis + theme generation (step 3 of onboarding) |

### Content themes
| Tool | Description |
|------|-------------|
| `list_themes` | List all content themes with IDs |
| `generate_themes` | AI-generate new themes (uses credits) |
| `edit_theme` | Update a theme's title or instructions |
| `delete_theme` | Remove a theme |

### Social posts
| Tool | Description |
|------|-------------|
| `generate_post` | AI-generate a post for a platform |
| `create_post` | Save a manual post draft to one or more platforms |
| `list_posts` | List posts filtered by status or platform |
| `get_post` | View a single post |
| `approve_post` | Approve and schedule a draft post |
| `schedule_post` | Set a scheduled time on an existing post |
| `reschedule_post` | Move a scheduled post to a new time |
| `cancel_post` | Cancel a scheduled post without deleting it |
| `delete_post` | Cancel and delete a post |
| `get_calendar` | View upcoming scheduled content |
| `generate_bulk_posts` | Fill a date range with AI-generated posts |

### Repurpose
| Tool | Description |
|------|-------------|
| `repurpose_content` | Turn a URL, text, or existing post into new social or blog content |

### Voice profiles
| Tool | Description |
|------|-------------|
| `list_voices` | List available voice profiles |
| `rewrite_with_voice` | Rewrite text in a specific voice |

### Social accounts
| Tool | Description |
|------|-------------|
| `check_social_accounts` | List connected and disconnected platforms |
| `generate_connect_link` | Get a secure OAuth link to connect a platform |
| `disconnect_social_account` | Disconnect a social account |

### Reddit
_Reddit is a repurpose-to-Reddit workflow, not a scheduled publishing medium. Flow: `reddit_generate_pool` → `reddit_get_pool` → `reddit_suggest` → `reddit_rewrite` → `reddit_list_posts`._

| Tool | Description |
|------|-------------|
| `reddit_get_pool` | View the brand's saved pool of relevant subreddits, sorted by relevance score |
| `reddit_generate_pool` | Async: discover and score relevant subreddits for the brand by crawling Reddit |
| `reddit_global_pool` | Return stats on the global subreddit dataset (informational only) |
| `reddit_suggest` | Sync: suggest up to 8 best-fit subreddits for a specific piece of content, each with 2-3 posting angles, promotion mode, and buyer intent |
| `reddit_rewrite` | Async: rewrite a blog article or raw content as a native Reddit post for a target subreddit |
| `reddit_list_posts` | List saved Reddit posts (outputs of `reddit_rewrite`), cursor-paginated |

### Blog
| Tool | Description |
|------|-------------|
| `list_blogs` | List publications and articles (filterable by status) |
| `list_publications` | List publications only |
| `create_publication` | Create a new blog publication |
| `update_publication` | Update an existing publication's title, description, domain/routing, or layout (partial update) |
| `generate_blog_post` | AI-generate a full blog article with optional voice |
| `get_blog_article` | Fetch full article content |
| `get_blog_status` | Poll generation/publish status for an article |
| `update_blog_article` | Edit title, content, SEO fields, author, category, or status |
| `delete_blog_article` | Permanently delete an article |
| `publish_blog_article` | Push to WordPress, Medium, Substack, etc. |
| `list_publishing_connections` | List external platform connections |
| `import_blog_articles` | Import from RSS feed or Blogger URL |
| `list_blog_authors` | List blog authors |
| `create_blog_author` | Create a new blog author |
| `list_blog_categories` | List categories for a publication |
| `create_blog_category` | Create a new category |
| `get_seo_roadmap` | View SEO / GEO topic suggestions and completion stats |

### SEO / GEO
_Canonical flow: `seo_add_seeds` → `seo_generate_keywords` → `seo_categorize` → `seo_generate_clusters` → approve clusters → `seo_generate_roadmap` → review briefs → `seo_approve_briefs` (auto-fires article generation) → poll `get_job` → audit & publish._

| Tool | Description |
|------|-------------|
| `seo_add_seeds` | Seed SEO / GEO research with 3–10 topic keywords |
| `seo_generate_keywords` | Async: expand seeds into a full keyword universe (poll via `get_job`) |
| `seo_list_keywords` | List researched keywords with intent, priority, and volume |
| `seo_edit_keyword` | Edit a keyword — override intent, adjust priority, set user tags, or exclude from clustering |
| `seo_delete_keyword` | Soft-delete a single keyword from the research set |
| `seo_categorize` | Tag keywords by search intent and/or user tags |
| `seo_generate_clusters` | Async: group keywords into topic clusters (poll via `get_job`) |
| `seo_list_clusters` | List keyword clusters with brief-generation status |
| `seo_bulk_approve_clusters` | Bulk-approve N clusters in one call, kicking off async brief generation for each |
| `seo_approve_cluster` | Approve a single cluster, gating brief generation for it |
| `seo_reject_cluster` | Reject a single cluster — marks it rejected and detaches its keywords |
| `seo_bulk_reject_clusters` | Bulk-reject N clusters in one call |
| `seo_unapprove_cluster` | Revert an approved cluster back to pending_review |
| `seo_restore_cluster` | Restore a rejected cluster back to pending_review |
| `seo_generate_roadmap` | Turn one or more clusters into a prioritized content roadmap |
| `seo_list_roadmap` | List roadmap items (blog topics queued for writing) |
| `seo_roadmap_get` | Fetch a single roadmap item |
| `seo_roadmap_edit` | Edit a roadmap item's title, status, or priority |
| `seo_roadmap_delete` | Permanently delete a roadmap item |
| `seo_roadmap_stats` | Roadmap completion stats |
| `seo_list_briefs` | List content briefs across all clusters and statuses |
| `seo_get_brief` | Fetch a single brief including its full structured outline |
| `seo_edit_brief` | Edit a brief's structured outline or approve/reject it |
| `seo_approve_briefs` | Bulk-approve briefs and auto-fire article generation |
| `seo_regenerate_brief` | Re-run brief generation for a single brief |
| `seo_list_results` | List generated results (blog articles, side pages, comparisons) from the SEO pipeline |
| `seo_write_article` | Manual path: draft a blog article from a roadmap item (use only when not going through `seo_approve_briefs`) |
| `seo_gap` | Find keyword / topic gaps vs. existing content |
| `seo_competitor` | Compare keyword coverage against a competitor domain |
| `seo_publish_article` | Publish or schedule an SEO-drafted article to a publication |
| `seo_auto_assign_cta` | Auto-suggest and assign side-page CTAs to published blog articles |
| `seo_generate_side_page` | Generate a side page optionally linked to an SEO cluster |

### Landing pages
| Tool | Description |
|------|-------------|
| `list_landing_pages` | List all landing pages for a brand |
| `generate_landing_page` | Create and AI-generate a new landing page (async; poll via `get_job`) |
| `view_landing_page` | View a landing page including full section content |
| `view_lp_draft` | View the current unpublished draft |
| `edit_landing_page` | Edit landing page title or instructions (metadata only — does not touch page content) |
| `set_landing_page_section` | Set one field (dot-path) or replace a whole section on a landing page's draft |
| `regenerate_landing_page` | Re-generate a landing page's content using AI (async; poll via `get_job`) |
| `vibe_edit_landing_page` | Apply a natural-language AI edit to a landing page (async; propose → review → apply flow) |
| `get_vibe_edit_status` | Poll vibe-edit session status and review the field-level `changes` diff |
| `apply_vibe_edit` | Apply a completed vibe edit (all or a subset) to the draft as one new version |
| `set_lp_section_layout` | Reorder and/or toggle visibility of landing page sections |
| `publish_landing_page` | Publish the current draft |
| `delete_landing_page` | Permanently delete a landing page |
| `list_lp_versions` | List historical versions of a landing page |
| `view_lp_version` | View a specific historical version |
| `restore_lp_version` | Roll the draft back to a prior version |
| `delete_lp_version` | Permanently delete a historical version |
| `list_side_pages` | List side pages attached to a landing page |
| `generate_side_page` | AI-generate a side page under a parent landing page (async; poll via `get_job`) |
| `view_side_page` | View a side page including sections and rendered HTML |
| `edit_side_page` | Update the instructions or metadata of a side page |
| `set_side_page_section` | Update the content of a specific section within a side page |
| `set_side_page_state` | Publish or unpublish a side page |
| `delete_side_page` | Delete a side page |

### Weekly schedule
| Tool | Description |
|------|-------------|
| `get_weekly_schedule` | Fetch the active weekly posting schedule |
| `set_weekly_schedule` | Configure platforms, times, and themes per day |
| `enable_weekly_schedule` | Turn the weekly auto-generator on |
| `disable_weekly_schedule` | Turn the weekly auto-generator off |
| `delete_weekly_schedule` | Remove the schedule entirely |
| `run_weekly_schedule_day` | Generate a single day's posts on demand |

### Visuals (asset library)
| Tool | Description |
|------|-------------|
| `list_assets` | List brand assets (images/videos) with filters |
| `view_asset` | Fetch a single asset's metadata and URL |
| `upload_asset` | Upload an image/video (base64) |
| `import_asset_from_url` | Pull an asset from a remote URL |
| `import_assets_csv` | Batch-import up to 50 assets from a list of public URLs |
| `tag_asset` | Add or remove tags on an asset |
| `delete_asset` | Remove an asset (requires confirm) |
| `list_asset_tags` | List all tags used across assets |
| `suggest_assets_for_post` | Get AI-suggested assets for a specific post |
| `search_stock_images` | Search stock-photo libraries |

### Post visuals (cards & carousels)
| Tool | Description |
|------|-------------|
| `generate_post_visual_options` | Fetch available visual options for a post (card templates, library matches, stock photos) |
| `regenerate_post_visual` | Regenerate the visual option set for a post |
| `pick_post_visual` | Select a visual for a post on a given platform |
| `clear_post_visual` | Remove the selected visual from a post |
| `list_post_cards` | List the carousel cards attached to a post |
| `edit_post_card` | Edit a single carousel card by 1-based index |
| `set_post_cards` | Bulk-replace all carousel cards for a post |
| `generate_post_carousel` | Render a carousel PDF from the current cards |

### Jobs (async poller)
| Tool | Description |
|------|-------------|
| `list_jobs` | List recent async jobs for the active brand |
| `list_operations` | List recent Operations (the newer async-op system) with kind and state filters |
| `get_job` | Poll a specific operation by ID or pollUrl; supports `wait=true` to block until done |
| `cancel_job` | Cancel a pending or running job/operation by operationId |

### API keys (self-service)
| Tool | Description |
|------|-------------|
| `list_api_keys` | List your PostKing API keys |
| `create_api_key` | Mint a new API key |
| `revoke_api_key` | Revoke an API key (requires confirm) |

### Domains
| Tool | Description |
|------|-------------|
| `list_domains` | List domains with verification and SSL status |
| `add_domain` | Add a new custom domain |
| `verify_domain` | Check DNS and activate a domain |
| `delete_domain` | Remove a domain (content is preserved) |
| `connect_domain_to_publication` | Wire a verified domain to a blog publication |

### Writing tools
| Tool | Description |
|------|-------------|
| `rewrite_text` | Rewrite text using a voice profile or brand rules |
| `humanize_text` | Reduce AI detection signals in text |
| `check_ai_content` | Score text for AI detection likelihood |
| `get_credits` | Check your current credit balance and free-tier status |
| `health` | Check PostKing API health and version (no authentication required) |

### Storylines (marketing plans)
_Canonical flow: `storyline_create` → `storyline_clarify` (loop) → `storyline_generate_brief` (poll) → `storyline_get` → `storyline_edit_brief` → `storyline_confirm_brief` → `storyline_generate_strategy` (poll) → curate line items → `storyline_estimate` → `storyline_execute` (poll)._

| Tool | Description |
|------|-------------|
| `storyline_list` | List the brand's storylines (marketing plans) |
| `storyline_create` | Create a new storyline with a campaign goal or intent prompt |
| `storyline_get` | Fetch a single storyline with full state (brief, strategy, line items, status) |
| `storyline_update` | Update storyline metadata: title, live status, or start/end/launch dates |
| `storyline_delete` | Archive (soft-delete) a storyline — reversible via `storyline_restore` |
| `storyline_restore` | Restore an archived storyline back to active state |
| `storyline_clarify` | Run the intake/clarification step (iterative Q&A until system has enough context) |
| `storyline_generate_brief` | Async: generate the marketing brief — positioning, key messages, audience, timing (poll via `get_job`) |
| `storyline_set_brief` | Manually set (replace) the full brief for a storyline |
| `storyline_edit_brief` | AI-edit the brief using natural-language instructions |
| `storyline_confirm_brief` | Confirm the brief and gate strategy generation |
| `storyline_get_strategy` | Fetch the generated strategy and its line items |
| `storyline_generate_strategy` | Async: generate the execution strategy and line item set (poll via `get_job`) |
| `storyline_edit_strategy` | AI-edit the strategy using natural-language instructions |
| `storyline_estimate` | Dry-run credit estimate for executing the storyline |
| `storyline_add_line_item` | Add a new content line item to the strategy |
| `storyline_update_line_item` | Edit an existing line item (channel, type, title, selected flag, etc.) |
| `storyline_delete_line_item` | Permanently remove a line item from the strategy (confirm: true required) |
| `storyline_regenerate_line_item` | Async: regenerate a single strategy line item (poll via `get_job`) |
| `storyline_execute` | Async: generate all selected drafts from the strategy (poll via `get_job`) |

### Competitors (intelligence)
_Canonical flow: `competitor_probe` → `competitor_probe_status` → `competitor_probe_classify` → `competitor_add` (poll) → `competitor_analyze` (poll) → `competitor_list` → `competitor_get_comparison`/`recompute` → `competitor_get_overview`/`generate_overview` (poll). Namespace: `competitor_*` (distinct from `seo_competitor`/`seo_gap`)._

| Tool | Description |
|------|-------------|
| `competitor_list` | List tracked competitors with status, analysis state, and a dashboard deep-link |
| `competitor_add` | Async: batch-add 1–20 competitor domains and trigger crawl + profile analysis (poll via `get_job`) |
| `competitor_update` | Update competitor settings — e.g. toggle `excludeFromSeoPull` |
| `competitor_delete` | Soft-delete a tracked competitor (restorable via `competitor_update` with empty body) |
| `competitor_analyze` | Async: re-analyze pending or failed competitor rows (poll via `get_job`) |
| `competitor_refresh` | Async: refresh all active competitors — re-crawl + re-profile (poll via `get_job`) |
| `competitor_get_comparison` | Get the brand's head-to-head competitive comparison |
| `competitor_recompute_comparison` | Trigger a fresh comparison recompute (call after adding/analyzing competitors) |
| `competitor_get_overview` | Get the saved competitive landscape overview |
| `competitor_generate_overview` | Async: generate a fresh AI-synthesized landscape overview (poll via `get_job`) |
| `competitor_comparison_sources` | List SEO keyword sources that feed the competitive comparison |
| `competitor_probe` | Async: discover and surface rival domain candidates based on the brand (poll via `get_job`) |
| `competitor_probe_status` | Check the status of a probe run and list discovered candidates |
| `competitor_probe_classify` | Classify a probe candidate as add, skip, or blacklist |

### Knowledge base
_Canonical flow: `knowledge_list` → `knowledge_get` → `knowledge_create` (poll `get_job`) → `knowledge_update` → `knowledge_delete`._

| Tool | Description |
|------|-------------|
| `knowledge_list` | List knowledge base items — filter by tag, active status, or global flag |
| `knowledge_create` | Async: create a knowledge base item with optional AI enrichment (poll via `get_job`) |
| `knowledge_get` | Fetch a single knowledge base item with full content and metadata |
| `knowledge_update` | Update a knowledge base item's name, description, content, or tags |
| `knowledge_delete` | Soft-delete a knowledge base item |

### Brand truth
_Atomic facts/observations about a brand (hard facts, audience truths, strategy notes, negative space, content insights, topics) used to ground generation. Canonical flow: `brand_truth_list` → `brand_truth_get` → `brand_truth_create` (LLM extraction decides what to store) → `brand_truth_update` → `brand_truth_delete`._

| Tool | Description |
|------|-------------|
| `brand_truth_list` | List stored brand truths — filter by type, personaScope, tags, or free-text query |
| `brand_truth_get` | Fetch a single brand truth with full content and metadata |
| `brand_truth_create` | Describe facts in plain language; an LLM extraction pipeline decides which atomic truths to store vs skip (returns `added` + `skipped`) |
| `brand_truth_update` | Direct field edit of a known truth (name, description, content, tags, type, personaScope, pinned) — does not re-run the LLM |
| `brand_truth_delete` | Delete a truth and record rejection memory so it stops being re-suggested |

### Audience / ICP
_The brand's audience intelligence (ideal customer profile) mined from its website + onboarding. Canonical flow: `get_audience` → `preview_audience_edit` (discover valid sections) → `edit_audience` (async LLM ai-edit; poll `get_job`)._

| Tool | Description |
|------|-------------|
| `get_audience` | Fetch the brand's ICP — structured `audienceData`, positioning, ghostwriter `persona`, and contentModulation (short/medium/full) |
| `preview_audience_edit` | Read-only: discover which `sections`/`subsections` are valid to edit for this brand before calling `edit_audience` |
| `edit_audience` | Async LLM ai-edit of the audience/ICP (`sections` required; poll via `get_job`) — returns `already_running` if an edit is in flight |

### Trends and content templates
_Canonical flow: `trends_list` → `template_extract` OR (`template_list` + `template_pick`) → `template_create` → existing post-generation tools. Note: `trends_list` is account-scoped (no brand required)._

| Tool | Description |
|------|-------------|
| `trends_list` | List trending posts by niche and platform — account-scoped, no brand required |
| `template_list` | List saved content templates for the brand |
| `template_create` | Save or build a new content template |
| `template_update` | Update a template's title, content, or favorite flag |
| `template_delete` | Delete a saved content template |
| `template_extract` | AI: deconstruct a trending post into a reusable content template |
| `template_pick` | AI: score and rank existing templates for a given theme or content goal |

### Billing (agent wallet + subscription)
_Canonical flow (one-off): `billing_list_packs` → `billing_topup` → (Stripe Link or browser) → `billing_wallet` (poll until balance rises). Subscription: `billing_list_tiers` → `billing_subscribe` → (human or first-invoice Link) → subscription activates automatically._

| Tool | Description |
|------|-------------|
| `billing_list_packs` | List available agent credit packs with SKU, price, and credit amount |
| `billing_topup` | Create a Stripe Checkout session to top up the agent wallet with a one-off credit pack |
| `billing_wallet` | Fetch the agent's prepaid credit balance and recent ledger entries |
| `billing_list_tiers` | List available PostKing subscription tiers with pricing and monthly credits |
| `billing_subscribe` | Create a Stripe Checkout session for a GROWTH, PRO, or ENTERPRISE subscription |

### Dashboard
| Tool | Description |
|------|-------------|
| `dashboard_link` | Get a clickable browser URL to any section of the PostKing dashboard (overview, SEO, posts, blogs, landing pages, reddit, storylines, knowledge, trends, competitors, jobs, etc.) |

---

## Guided prompts

The server ships with built-in prompts accessible from the prompt picker in Claude Desktop:

| Prompt | Description |
|--------|-------------|
| `getting_started` | First-time setup: login → brand → connect → first post |
| `repurpose_and_schedule` | URL/text → repurpose → draft → approve → calendar |
| `connect_social_accounts` | Check and connect LinkedIn, X, Instagram, Threads, Facebook |
| `manage_posts` | View, reschedule, and delete posts |
| `manage_themes` | Generate, edit, and organize content themes |
| `blog_publishing` | Generate, edit, and publish blog posts |
| `use_voice_profiles` | Apply a voice style to generated or rewritten content |
| `plan_storyline_campaign` | Full marketing storyline: clarify → brief → strategy → curate → execute |
| `competitor_intelligence` | Build competitive intelligence: probe → add → analyze → comparison → overview |
| `manage_knowledge_base` | Browse, create, update, and soft-delete brand knowledge base items |
| `trends_to_post` | Browse trending posts, extract/pick a template, then generate a post |

---

## Example workflows

**Repurpose a blog post to LinkedIn and X:**
> "Repurpose https://myblog.com/my-article for LinkedIn and X, using my brand voice"

**Generate and schedule a week of content:**
> "Generate 7 LinkedIn posts using my growth themes, schedule them daily at 9am starting Monday"

**Write and publish a blog post:**
> "Write a 1500-word post about AI productivity tools, publish it to my blog"

**Import and repurpose existing content:**
> "Import the last 20 posts from https://myblog.com/feed and convert the top 5 into LinkedIn posts"

---

## Requirements

- Node.js 18 or later
- A PostKing account — [sign up free at postking.app](https://postking.app)

---

## Publishing to external platforms

PostKing supports publishing blog articles directly to:
- WordPress (via REST API)
- Medium
- Substack
- Webflow
- Any platform with a publishing connection

Set up connections in your PostKing dashboard under **Blog → Publishing Connections**, then use `publish_blog_article` from Claude.

---

## Development

```bash
git clone https://github.com/bitsandtea/postking-mcp
cd postking-mcp
npm install
npm run build
```

Test locally by pointing Claude Desktop at the built file:

```json
{
  "mcpServers": {
    "postking": {
      "command": "node",
      "args": ["/absolute/path/to/postking-mcp/dist/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTKING_API_URL` | `https://try.postking.app` | Override the API base URL |
| `POSTKING_API_TOKEN` | — | Skip device login by providing a token directly |

---

## Contributing

Issues and pull requests are welcome. This repo is the MCP client layer only — it calls the PostKing API and exposes tools to any MCP-compatible AI client. If you find a bug, want to add a tool, or improve the prompts, open an issue or PR.

---

## License

MIT
