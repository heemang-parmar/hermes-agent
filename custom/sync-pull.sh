#!/usr/bin/env bash
# MacBook side of the custom-app sync (custom/README.md § Keeping the MacBook in sync).
#
# Run by launchd every 15 minutes and kicked by the Studio's sync-push right after a push.
# Fast-forwards custom/desktop from the fork and, when the tip is not the one last built here,
# rebuilds and relaunches "Hermes (Custom)". A failed build leaves the stamp alone, so the next
# run retries the same commit instead of silently skipping it.
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH=custom/desktop
FORK_URL=https://github.com/heemang-parmar/hermes-agent.git
STAMP="$HOME/Library/Application Support/hermes-custom-sync/built-rev"

export PATH="$HOME/.hermes/tools/node-26.7.0-darwin-arm64/bin:$HOME/.hermes/tools/npm-12.0.2-darwin-arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$(git -C "$WORKTREE" branch --show-current)" != "$BRANCH" ]]; then
  echo "$(date '+%F %T') worktree is not on $BRANCH; not syncing" >&2
  exit 1
fi

GIT_TERMINAL_PROMPT=0 git -C "$WORKTREE" fetch --quiet "$FORK_URL" "$BRANCH"
before="$(git -C "$WORKTREE" rev-parse HEAD)"
target="$(git -C "$WORKTREE" rev-parse FETCH_HEAD)"

if [[ "$before" != "$target" ]]; then
  # Never rewrite: a MacBook-only commit means someone worked here; leave it for a human.
  if ! git -C "$WORKTREE" merge-base --is-ancestor HEAD FETCH_HEAD; then
    echo "$(date '+%F %T') local $BRANCH has commits the fork lacks; not syncing" >&2
    exit 1
  fi
  echo "$(date '+%F %T') fast-forward ${before:0:10} -> ${target:0:10}"
  git -C "$WORKTREE" merge --quiet --ff-only FETCH_HEAD
fi

head="$(git -C "$WORKTREE" rev-parse HEAD)"
built="$(cat "$STAMP" 2>/dev/null || true)"

if [[ "$head" == "$built" ]]; then
  exit 0
fi

# The desktop workspace hoists its dependencies to the repo root.
if [[ -z "$built" ]] || ! git -C "$WORKTREE" diff --quiet "$built" "$head" -- package-lock.json 2>/dev/null; then
  echo "$(date '+%F %T') installing dependencies"
  (cd "$WORKTREE" && npm ci --no-audit --no-fund --loglevel=error)
fi

echo "$(date '+%F %T') building ${head:0:10}"
"$WORKTREE/custom/build-desktop.sh" --relaunch
mkdir -p "$(dirname "$STAMP")"
echo "$head" > "$STAMP"
echo "$(date '+%F %T') ✓ running ${head:0:10}"
