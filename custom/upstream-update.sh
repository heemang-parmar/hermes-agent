#!/usr/bin/env bash
# Take the newest official upstream build into custom/desktop, gated (custom/README.md
# § Taking an upstream update). Studio only; the MacBook follows through sync-push/sync-pull.
#
#   custom/upstream-update.sh            newest canary tag (upstream main, built and tagged by CI)
#   custom/upstream-update.sh stable     newest stable vX.Y.Z tag
#
# The merge happens in its own worktree. custom/desktop moves only when every gate passes:
#   1. a true merge with no conflicts (never a rebase);
#   2. the custom line's delta over upstream is line-for-line what it was before the merge;
#   3. typecheck, lint, the renderer suite and the build pass; the electron suite may fail only
#      where pre-merge custom/desktop fails the same way (host-specific tests);
#   4. the pinned backend regressions pass.
# Any failure leaves the candidate branch and worktree for a human and posts a notification.
set -euo pipefail

LIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HOME/.hermes-integration"
CHANNEL="${1:-canary}"
export PATH="$HOME/.hermes/tools/node-26.7.0-darwin-arm64/bin:$HOME/.hermes/tools/npm-12.0.2-darwin-arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin"

say() { echo "$(date '+%F %T') $*"; }
fail() {
  say "✗ $*"
  osascript -e "display notification \"$*\" with title \"Hermes (Custom) upstream update\"" >/dev/null 2>&1 || true
  exit 1
}
failing_tests() { grep -E '^ FAIL ' "$1" | sed -E 's/ +[0-9]+ms$//' | sort -u; }

case "$CHANNEL" in
  canary) pattern='v*+canary.*' ;;
  stable) pattern='v[0-9]*' ;;
  *) fail "unknown channel '$CHANNEL' (canary|stable)" ;;
esac

# Newest by version, then by canary timestamp. Stable is the vX.Y.Z release line only: no
# +canary builds and no calendar vYYYY.M.D tags, which name different commits.
tag="$(git -C "$LIVE" ls-remote --tags --refs origin "$pattern" | awk '{sub("refs/tags/", "", $2); print $2}' \
  | { if [[ $CHANNEL == stable ]]; then grep -E '^v[0-9]{1,3}\.[0-9]+\.[0-9]+$'; else cat; fi; } \
  | awk -F'[v.+]' '{printf "%05d%05d%05d %s\n", $2, $3, $4, $0}' | sort | tail -1 | cut -d' ' -f2)"
[[ -n "$tag" ]] || fail "no $CHANNEL tag found upstream"

git -C "$LIVE" fetch -q origin "refs/tags/$tag:refs/tags/$tag"
target="$(git -C "$LIVE" rev-parse "$tag^{commit}")"

if git -C "$LIVE" merge-base --is-ancestor "$target" custom/desktop; then
  say "custom/desktop already contains $tag"
  exit 0
fi

slug="$(echo "$tag" | tr -c 'A-Za-z0-9.\n' '-')"
branch="custom/upstream-$slug"
work="$ROOT/upstream-$slug"
git -C "$LIVE" rev-parse -q --verify "refs/heads/$branch" >/dev/null \
  && fail "$branch already exists from an earlier attempt; review or delete it first"
[[ -z "$(git -C "$LIVE" status --porcelain)" ]] || fail "custom/desktop worktree has uncommitted changes"

say "merging $tag (${target:0:10}) into custom/desktop in $work"
previous="$(git -C "$LIVE" merge-base custom/desktop "$target")"
git -C "$LIVE" worktree add -q -b "$branch" "$work" custom/desktop
cd "$work"

if ! git merge -q --no-edit -m "merge: upstream $tag (${target:0:10}) into custom/desktop" "$target"; then
  conflicts="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
  git merge --abort
  fail "merge conflicts with $tag: $conflicts(left on $branch)"
fi

delta() { git diff "$1" "$2" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | sort; }
if ! diff -q <(delta "$previous" custom/desktop) <(delta "$target" HEAD) >/dev/null; then
  fail "the merge changed the custom delta over upstream; review $branch"
fi
say "custom delta preserved"

logs="$ROOT/upstream-$slug.logs"
mkdir -p "$logs"
npm ci --no-audit --no-fund --loglevel=error >"$logs/npm-ci.log" 2>&1 || fail "npm ci failed ($logs)"
cd apps/desktop
npm run typecheck >"$logs/typecheck.log" 2>&1 || fail "typecheck failed ($logs/typecheck.log)"
npm run lint >"$logs/lint.log" 2>&1 || fail "lint failed ($logs/lint.log)"
npx vitest run --project ui >"$logs/vitest-ui.log" 2>&1 || fail "renderer tests failed ($logs/vitest-ui.log)"

if ! npx vitest run --project electron >"$logs/vitest-electron.log" 2>&1; then
  files="$(failing_tests "$logs/vitest-electron.log" | sed -E 's/^ FAIL +\|electron\| ([^ ]+) .*/\1/' | sort -u)"
  # shellcheck disable=SC2086 # one path per word
  (cd "$LIVE/apps/desktop" && npx vitest run --project electron $files >"$logs/vitest-electron-before.log" 2>&1) || true
  new="$(comm -23 <(failing_tests "$logs/vitest-electron.log") <(failing_tests "$logs/vitest-electron-before.log"))"
  [[ -z "$new" ]] || fail "electron tests newly failing after the merge ($logs/vitest-electron.log)"
  say "electron failures are pre-existing on this host"
fi

npm run build >"$logs/build.log" 2>&1 || fail "build failed ($logs/build.log)"
cd "$work"

home="$(mktemp -d)"
HOME="$home" scripts/run_tests.sh \
  tests/hermes_cli/test_model_picker_global_root_fallback.py \
  tests/hermes_cli/test_provider_models_cache_inherits_root.py \
  tests/tui_gateway/test_profiles_list_avatar_rev.py \
  tests/tui_gateway/contracts/ >"$logs/pytest.log" 2>&1 || fail "pinned backend tests failed ($logs/pytest.log)"
rm -rf "$home"
say "all gates green"

git -C "$LIVE" merge -q --ff-only "$branch"
(cd "$LIVE" && npm ci --no-audit --no-fund --loglevel=error >"$logs/npm-ci-live.log" 2>&1)
"$LIVE/custom/build-desktop.sh" --relaunch >"$logs/install.log" 2>&1 || fail "Studio rebuild failed ($logs/install.log)"
git -C "$LIVE" worktree remove --force "$work"
git -C "$LIVE" branch -q -d "$branch"
"$LIVE/custom/sync-push.sh" || true
say "✓ custom/desktop now carries $tag; the MacBook follows via sync-pull"
