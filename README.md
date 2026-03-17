# PostKing MCP Server

[![npm version](https://img.shields.io/npm/v/postking-mcp)](https://www.npmjs.com/package/postking-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [PostKing](https://postking.app) — an AI-powered content platform for social media scheduling, blog publishing, and brand management.

Connect Claude (Desktop, Cursor, or any MCP client) to your PostKing account and manage your entire content operation through conversation — generate posts, schedule them, repurpose URLs into social content, write and publish blog articles, manage domains, and more.

---

## Quick start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop, then tell Claude: **"Login to PostKing"**

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
| `reschedule_post` | Move a scheduled post to a new time |
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
| `create_publication` | Create a new blog publication |
| `generate_blog_post` | AI-generate a full blog article with optional voice |
| `get_blog_article` | Fetch full article content |
| `update_blog_article` | Edit title, content, SEO fields, author, category, or status |
| `delete_blog_article` | Permanently delete an article |
| `publish_blog_article` | Push to WordPress, Medium, Substack, etc. |
| `list_publishing_connections` | List external platform connections |
| `import_blog_articles` | Import from RSS feed or Blogger URL |
| `list_blog_authors` | List blog authors |
| `list_blog_categories` | List categories for a publication |
| `create_blog_category` | Create a new category |
| `get_seo_roadmap` | View SEO topic suggestions and completion stats |

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
| `POSTKING_API_URL` | `https://try.postking.app` | Override API base URL (useful for local dev) |
| `POSTKING_API_TOKEN` | — | Skip device login by providing a token directly |

---

## Contributing

Issues and pull requests are welcome. This repo is the MCP client layer only — it calls the PostKing API and exposes tools to any MCP-compatible AI client. If you find a bug, want to add a tool, or improve the prompts, open an issue or PR.

---

## License

MIT
