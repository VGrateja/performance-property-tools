#!/usr/bin/env bash
# =============================================================================
# deploy-staging.sh — publish any branch to the staging site Kia and Saskia use.
#
#   https://vgrateja.github.io/pp-hub-preview/
#
# Usage:
#   bash scripts/deploy-staging.sh              # deploys the CURRENT branch
#   bash scripts/deploy-staging.sh main         # deploys main (staging = live)
#   bash scripts/deploy-staging.sh my-feature   # deploys a feature branch
#
# WHY A SCRIPT AND NOT `git push preview <branch>:main`
# -----------------------------------------------------
# CNAME. That file holds tools.performanceproperty.com.au. GitHub Pages honours
# it per-site, so pushing it to the staging repo points the LIVE DOMAIN at
# staging and takes production down. Every deploy must strip it, and "remember
# to delete a file first" is not a process. This script removes it in a
# temporary index and REFUSES to push if it is still there.
#
# It never touches your working tree or checks anything out — it builds the
# commit with plumbing, so it is safe to run mid-edit.
#
# The Supabase redirect URL for this site is already allow-listed, so Google
# sign-in works. Staging shares the PRODUCTION DATABASE: it is a UI preview,
# not an isolated environment. Tell reviewers to browse, not edit.
# =============================================================================
set -euo pipefail

REMOTE="preview"
SITE="https://vgrateja.github.io/pp-hub-preview/"
REPO="VGrateja/pp-hub-preview"
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

cd "$(git rev-parse --show-toplevel)"

git remote get-url "$REMOTE" >/dev/null 2>&1 || {
  echo "✗ no '$REMOTE' remote. Add it with:"
  echo "    git remote add $REMOTE https://github.com/$REPO.git"
  exit 1
}
git rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null || {
  echo "✗ no such branch: $BRANCH"; exit 1; }

SHA=$(git rev-parse --short "$BRANCH")
SUBJ=$(git log -1 --format=%s "$BRANCH")
echo "Deploying to staging"
echo "  branch : $BRANCH ($SHA)"
echo "  commit : $SUBJ"

# Build the tree in a THROWAWAY index so the working tree is untouched.
TMPIDX="$(mktemp -t ppstaging.XXXXXX)"
trap 'rm -f "$TMPIDX"' EXIT
export GIT_INDEX_FILE="$TMPIDX"
git read-tree "$BRANCH"

if git ls-files --cached --error-unmatch CNAME >/dev/null 2>&1; then
  git rm --cached -q CNAME
  echo "  CNAME  : stripped (it would hijack the production domain)"
else
  echo "  CNAME  : not present on this branch"
fi

TREE=$(git write-tree)

# Belt and braces: prove it is gone before anything leaves the machine.
if [ -n "$(git ls-tree "$TREE" CNAME)" ]; then
  echo "✗ CNAME is STILL in the tree — refusing to push."
  exit 1
fi

COMMIT=$(git commit-tree "$TREE" -p "$BRANCH" \
  -m "staging: $BRANCH @ $SHA

$SUBJ

Published by scripts/deploy-staging.sh. CNAME stripped so this site cannot
claim tools.performanceproperty.com.au.")

unset GIT_INDEX_FILE
git push -f "$REMOTE" "$COMMIT:refs/heads/main"
echo "  pushed : $(git rev-parse --short "$COMMIT")"

# Pages does not always auto-build; ask for one and wait.
if command -v gh >/dev/null 2>&1; then
  gh api -X POST "repos/$REPO/pages/builds" >/dev/null 2>&1 || true
  # Poll builds/latest, NOT repos/<r>/pages — the latter carries several
  # status-ish fields and a naive grep picked the wrong one, reporting a
  # perfectly healthy build as errored.
  printf '  build  : '
  for _ in $(seq 1 14); do
    st=$(gh api "repos/$REPO/pages/builds/latest" --jq .status 2>/dev/null || echo '')
    case "$st" in
      built)   echo "built"; break ;;
      errored) echo "ERRORED"; gh api "repos/$REPO/pages/builds/latest" --jq .error.message 2>/dev/null; exit 1 ;;
      *)       printf '.'; sleep 12 ;;
    esac
  done
fi

echo
echo "Live at $SITE"
echo "Reviewers may need a hard-refresh — index.html is not cache-busted."
