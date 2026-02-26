#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint MCP v4.0 — Publish Script
# Usage: bash scripts/publish.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PACKAGE_VERSION=$(node -p "require('./package.json').version")
GIT_TAG="v${PACKAGE_VERSION}"

echo "==> Blueprint MCP Publish Pipeline — ${GIT_TAG}"
echo ""

# ── 1. Safety check: git working tree must be clean ──────────────────────────
echo "[1/6] Checking git working tree..."
if [[ -n "$(git status --porcelain)" ]]; then
    echo ""
    echo "ERROR: Your git working tree is dirty (uncommitted changes detected)."
    echo "Please commit or stash your changes before publishing."
    echo ""
    git status --short
    exit 1
fi
echo "      Working tree is clean."

# ── 2. Confirm we're on the right branch ─────────────────────────────────────
echo "[2/6] Checking current branch..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
    echo ""
    echo "WARNING: You are on branch '${CURRENT_BRANCH}', not 'main'."
    read -r -p "         Continue anyway? [y/N] " confirm
    if [[ "$confirm" != [yY] ]]; then
        echo "Aborted."
        exit 1
    fi
fi
echo "      Branch: ${CURRENT_BRANCH}"

# ── 3. Run the build ──────────────────────────────────────────────────────────
echo "[3/6] Building TypeScript..."
npm run build
echo "      Build successful."

# ── 4. Verify dist/index.js shebang & permissions ───────────────────────────
echo "[4/6] Verifying dist/index.js..."
FIRST_LINE=$(head -1 dist/index.js)
if [[ "$FIRST_LINE" != "#!/usr/bin/env node" ]]; then
    echo "ERROR: dist/index.js is missing the shebang. Run 'npm run build' manually."
    exit 1
fi
echo "      Shebang: OK"
echo "      Permissions: $(ls -la dist/index.js | awk '{print $1}')"

# ── 5. Publish to npm ────────────────────────────────────────────────────────
echo "[5/6] Publishing to npm as public package..."
npm publish --access public
echo "      Published blueprint-mcp@${PACKAGE_VERSION} to npm."

# ── 6. Tag & push the release ────────────────────────────────────────────────
echo "[6/6] Tagging release on GitHub..."

if git tag | grep -q "^${GIT_TAG}$"; then
    echo "      Tag ${GIT_TAG} already exists — skipping."
else
    git tag -a "${GIT_TAG}" -m "Release ${GIT_TAG} — Blueprint MCP v${PACKAGE_VERSION}"
    git push origin "${GIT_TAG}"
    echo "      Tag ${GIT_TAG} pushed to origin."
fi

echo ""
echo "==> Done! blueprint-mcp@${PACKAGE_VERSION} is live."
echo "    npm:    https://www.npmjs.com/package/blueprint-mcp"
echo "    GitHub: https://github.com/kunalBrahma/blueprint-mcp/releases/tag/${GIT_TAG}"
echo ""
echo "Next: go to GitHub → Releases → Draft new release from tag ${GIT_TAG}"
echo "      and paste in your changelog."
