#!/bin/bash

# PostKing MCP Deployment Script
# Deploys the hosted HTTP MCP server (postking-mcp) and restarts it under PM2.
# Stops execution on any failure

set -e  # Exit on any error

echo "🚀 Starting PostKing MCP deployment..."

# Load .env for Telegram credentials (if not already in environment)
if [ -f ".env" ]; then
    export $(grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' .env | xargs)
fi

# Send a Telegram message (silent – never blocks deployment)
send_telegram() {
    local message="$1"
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="${TELEGRAM_CHAT_ID}" \
            -d parse_mode="Markdown" \
            --data-urlencode "text=${message}" > /dev/null 2>&1 || true
    fi
}

DEPLOY_START=$(date '+%Y-%m-%d %H:%M:%S')
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

send_telegram "🚀 *PostKing MCP deploy started*
Branch: \`${GIT_BRANCH}\`
Commit: \`${GIT_COMMIT}\`
Time: ${DEPLOY_START}"

# Function to handle errors
handle_error() {
    echo "❌ Deployment failed at step: $1"
    echo "Please check the error above and fix it before retrying."
    send_telegram "❌ *PostKing MCP deploy FAILED*
Step: \`$1\`
Branch: \`${GIT_BRANCH}\`
Commit: \`${GIT_COMMIT}\`"
    exit 1
}

# Step 1: Git pull
echo "📥 Step 1: Pulling latest changes from git..."
if ! git pull; then
    handle_error "git pull"
fi
echo "✅ Git pull completed successfully"

# Step 2: Clean build artifacts
echo "🧹 Step 2: Cleaning build artifacts..."
if [ -d "node_modules" ]; then
    rm -rf node_modules
    echo "✅ Removed node_modules directory"
fi
if [ -d "dist" ]; then
    rm -rf dist
    echo "✅ Removed dist directory"
fi
echo "✅ Cleanup completed successfully"

# Step 3: Install dependencies
echo "📦 Step 3: Installing dependencies..."
if ! pnpm install; then
    handle_error "pnpm install"
fi
echo "✅ Dependencies installed successfully"

# Step 4: Typecheck
echo "🔍 Step 4: Type-checking..."
if ! pnpm typecheck; then
    handle_error "typecheck"
fi
echo "✅ Typecheck completed successfully"

# Step 5: Build the application
echo "🔨 Step 5: Building the application..."
export NODE_ENV=production
if ! pnpm build; then
    handle_error "pnpm build"
fi
echo "✅ Build completed successfully"

# Step 6: Reload PM2 process
# The PM2 process name can be overridden via the MCP_PM2_NAME env var.
# The process must already exist under PM2, e.g. started once with:
#   pm2 start "pnpm start:http" --name postking-mcp
echo "🔄 Step 6: Reloading PM2 process..."
PM2_NAME="${MCP_PM2_NAME:-postking-mcp}"
if ! pm2 reload "$PM2_NAME"; then
    handle_error "pm2 reload"
fi
echo "✅ PM2 reload completed successfully"

# Step 7: Notify success and show PM2 logs
echo "📋 Step 7: Showing PM2 logs..."
DEPLOY_END=$(date '+%Y-%m-%d %H:%M:%S')
send_telegram "✅ *PostKing MCP deployed successfully*
Branch: \`${GIT_BRANCH}\`
Commit: \`${GIT_COMMIT}\`
Time: ${DEPLOY_END}"
echo "✅ Deployment completed successfully! Showing logs:"
pm2 logs "$PM2_NAME"
