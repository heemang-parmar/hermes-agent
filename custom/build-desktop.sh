#!/usr/bin/env bash
# Build (and optionally relaunch) the customised Hermes desktop app from the
# custom/desktop worktree.
#
#   custom/build-desktop.sh            build only
#   custom/build-desktop.sh --relaunch build, quit the running app, install it as
#                                      /Applications/Hermes (Custom).app and open it
#
# Refuses to build while desktop source edits exist anywhere they would be lost:
#   * uncommitted edits in the main checkout (~/.hermes/hermes-agent) — they are
#     NOT in this worktree, so a build from here silently drops them (this is how
#     the bot-row designation change was lost once), and `hermes update` would
#     autostash them anyway;
#   * uncommitted edits in this worktree — the build would ship code that is not
#     in git, so the next rebase/rebuild could lose it.
# Commit desktop changes to the custom/desktop branch first, then build.
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="${HERMES_MAIN_CHECKOUT:-$HOME/.hermes/hermes-agent}"
PATHS=(apps/desktop apps/shared)
RELEASE="$WORKTREE/apps/desktop/release/mac-arm64"
# The packager writes Hermes.app; the custom line ships it as "Hermes (Custom).app"
# so it never reads as the stock release. Renaming the bundle keeps its signature.
APP="$RELEASE/Hermes (Custom).app"
# The running copy lives outside release/: before-pack wipes that directory on
# every build, which deleted a running app's bundle out from under it.
INSTALLED="/Applications/Hermes (Custom).app"

fail=0
main_dirty="$(git -C "$MAIN" status --porcelain -- "${PATHS[@]}" || true)"
if [[ -n "$main_dirty" ]]; then
  echo "✗ Uncommitted desktop edits in the main checkout ($MAIN):" >&2
  echo "$main_dirty" | sed 's/^/    /' >&2
  echo "  They are not in custom/desktop, so this build would drop them." >&2
  echo "  Move them over:  git -C \"$MAIN\" diff -- ${PATHS[*]} | git -C \"$WORKTREE\" apply --3way" >&2
  echo "  (copy any new '??' files too), commit on custom/desktop, then revert them in the main checkout." >&2
  fail=1
fi

wt_dirty="$(git -C "$WORKTREE" status --porcelain -- "${PATHS[@]}" || true)"
if [[ -n "$wt_dirty" ]]; then
  echo "✗ Uncommitted edits in the custom/desktop worktree — commit them first:" >&2
  echo "$wt_dirty" | sed 's/^/    /' >&2
  fail=1
fi

[[ $fail -eq 0 ]] || exit 1

export PATH="$HOME/.hermes/tools/node-26.7.0-darwin-arm64/bin:$HOME/.hermes/tools/npm-12.0.2-darwin-arm64/bin:$PATH"
# Ad-hoc local signing, as `hermes desktop` does; never grab a keychain identity.
export CSC_IDENTITY_AUTO_DISCOVERY=false

cd "$WORKTREE/apps/desktop"
echo "→ Building $(git -C "$WORKTREE" log -1 --format='%h %s')"
npm run build
npm run builder -- --dir --publish never
rm -rf "$APP"
mv "$RELEASE/Hermes.app" "$APP"

if [[ "${1:-}" == "--relaunch" ]]; then
  osascript -e 'tell application id "com.nousresearch.hermes" to quit' || true
  for _ in $(seq 1 30); do pgrep -f "\.app/Contents/MacOS/Hermes$" >/dev/null || break; sleep 1; done
  # Apple Events are refused from a launchd/SSH context; then the old app would hold the
  # single-instance lock and the new one exits at once. SIGTERM is Electron's normal quit.
  if pgrep -f "\.app/Contents/MacOS/Hermes$" >/dev/null; then
    pkill -TERM -f "\.app/Contents/MacOS/Hermes$" || true
    for _ in $(seq 1 30); do pgrep -f "\.app/Contents/MacOS/Hermes$" >/dev/null || break; sleep 1; done
  fi
  rm -rf "$INSTALLED"
  ditto "$APP" "$INSTALLED"
  open -n "$INSTALLED"
  echo "✓ Relaunched $INSTALLED"
else
  echo "✓ Built $APP (run with --relaunch to swap it in)"
fi
