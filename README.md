# PostKing MCP Server

[![npm version](https://img.shields.io/npm/v/postking-mcp)](https://www.npmjs.com/package/postking-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [PostKing](https://postking.app) — an AI-powered content platform for social media scheduling, blog publishing, and brand management.

Connect Claude (Desktop, Cursor, or any MCP client) to your PostKing account and manage your entire content operation through conversation — generate posts, schedule them, repurpose URLs into social content, write and publish blog articles, generate landing pages and side pages, run SEO research and drafting, manage your asset library and weekly posting schedule, handle domains and API keys, and more.

The server exposes **121 tools** across 15 modules — full parity with the `postking-cli`.

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
| Tool | Description |
|------|-------------|
| `login_start` | Begin device login — get a URL and code to approve in browser |
| `login_complete` | Finish login and save token after browser approval |
| `logout` | Clear locally stored credentials |
| `whoami` | Show the currently authenticated user and account |

### Brands
| Tool | Description |
|------|-------------|
| `list_brands` | List all brands on your account |
| `set_active_brand` | Set the default brand for this session |
| `get_brand_info` | View brand profile — tone, audience, themes |
| `create_brand` | Create a brand manually |
| `onboard_brand` | Crawl a website and auto-generate a brand profile + 10 themes |

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

### Blog
| Tool | Description |
|------|-------------|
| `list_blogs` | List publications and articles (filterable by status) |
| `list_publications` | List publications only |
| `create_publication` | Create a new blog publication |
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
| `get_seo_roadmap` | View SEO topic suggestions and completion stats |

### SEO
| Tool | Description |
|------|-------------|
| `seo_add_seeds` | Seed SEO research with topic keywords |
| `seo_generate_keywords` | Expand seeds into a keyword universe |
| `seo_list_keywords` | List researched keywords |
| `seo_categorize` | Categorize keywords by intent/funnel stage |
| `seo_cluster` | Cluster keywords into topic groups |
| `seo_list_clusters` | List keyword clusters |
| `seo_generate_roadmap` | Generate an article roadmap from clusters |
| `seo_list_roadmap` | List roadmap items |
| `seo_roadmap_get` | Fetch a single roadmap item |
| `seo_roadmap_edit` | Edit a roadmap item's title, intent, or notes |
| `seo_roadmap_delete` | Remove a roadmap item |
| `seo_roadmap_stats` | Roadmap completion stats |
| `seo_gap` | Find keyword gaps vs. existing content |
| `seo_competitor` | Analyze a competitor domain's keyword footprint |
| `seo_write_article` | Draft an article from a roadmap item |
| `seo_publish_article` | Publish an SEO-drafted article |

### Landing pages
| Tool | Description |
|------|-------------|
| `list_landing_pages` | List all landing pages for a brand |
| `generate_landing_page` | Generate a new landing page from a prompt |
| `view_landing_page` | View a published landing page |
| `view_lp_draft` | View the current working draft |
| `edit_landing_page` | Edit landing page content directly |
| `set_landing_page` | Replace a section or block in place |
| `regenerate_landing_page` | Regenerate the draft from the original prompt |
| `vibe_edit_landing_page` | Apply a natural-language vibe edit (async) |
| `get_vibe_edit_status` | Poll vibe-edit job status |
| `publish_landing_page` | Publish the current draft |
| `delete_landing_page` | Delete a landing page |
| `list_lp_versions` | List historical versions of a landing page |
| `view_lp_version` | View a specific historical version |
| `list_side_pages` | List side pages attached to a landing page |
| `generate_side_page` | Generate a new side page (async) |
| `get_side_page_status` | Poll side-page generation status |
| `view_side_page` | View a side page |
| `edit_side_page` | Edit side-page content |
| `set_side_page_section` | Replace a section of a side page |
| `set_side_page_state` | Flip a side page between draft/published |
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
| `import_assets_csv` | Bulk import assets from a CSV |
| `tag_asset` | Add or replace tags on an asset |
| `delete_asset` | Remove an asset (requires confirm) |
| `list_asset_tags` | List all tags used across assets |
| `suggest_assets_for_post` | Get AI-suggested assets for a specific post |
| `search_stock_images` | Search the stock-image providers |

### Post visuals (cards & carousels)
| Tool | Description |
|------|-------------|
| `generate_post_visual_options` | Generate visual option variants for a post |
| `regenerate_post_visual` | Regenerate a specific visual option |
| `pick_post_visual` | Pick a generated visual as the final |
| `clear_post_visual` | Clear the selected visual |
| `list_post_cards` | List card slides for a post |
| `edit_post_card` | Edit a single card's copy |
| `set_post_cards` | Replace all cards in one call |
| `generate_post_carousel` | Render a carousel from current cards |

### Jobs (async poller)
| Tool | Description |
|------|-------------|
| `list_jobs` | List recent async jobs (generate, vibe-edit, imports) |
| `get_job` | Poll a specific job by ID |

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
| `connect_domain_to_publication` | Wire a domain to a blog publication |

### Writing tools
| Tool | Description |
|------|-------------|
| `rewrite_text` | Rewrite text using a voice profile or brand rules |
| `humanize_text` | Reduce AI detection signals in text |
| `check_ai_content` | Score text for AI detection likelihood |
| `get_credits` | Check your current credit balance |

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
