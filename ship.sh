#!/usr/bin/env bash
# Local dev ship script — build, link, pack, scp + install on the remote Mac.
# Usage: ./ship.sh
set -euo pipefail

cd "$(dirname "$0")"

REMOTE="ditegashi@dites-macbook-pro.tailcbb0af.ts.net"
VERSION=$(node -p "require('./package.json').version")
TGZ="postking-mcp-${VERSION}.tgz"

echo "==> build"
npm run build

echo "==> link (global)"
npm link

echo "==> pack ${TGZ}"
rm -f postking-mcp-*.tgz
npm pack

echo "==> scp ${TGZ} to ${REMOTE}:~/"
scp "${TGZ}" "${REMOTE}:~/"

echo "==> install on remote"
ssh "${REMOTE}" "npm i -g ~/${TGZ} && echo 'installed postking-mcp@${VERSION}'"

echo "==> done (v${VERSION})"
