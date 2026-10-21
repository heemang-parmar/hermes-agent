#!/usr/bin/env bash
# Mac Studio side of the custom-app sync (custom/README.md § Keeping the MacBook in sync).
#
# Run by launchd every two minutes. When custom/desktop has commits the fork lacks, push them and
# poke the MacBook's sync-pull job so it rebuilds now instead of at its next poll. Only committed
# work travels: the MacBook builds exactly what is in git, never this machine's working tree.
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH=custom/desktop
MACBOOK=heemangparmar@heemangs-macbook-pro-1
MACBOOK_KEY="$HOME/.ssh/hermes_macbook_ed25519"
PULL_JOB=com.hermes.custom-sync-pull

local_rev="$(git -C "$WORKTREE" rev-parse "refs/heads/$BRANCH")"
fork_rev="$(GIT_TERMINAL_PROMPT=0 git -C "$WORKTREE" ls-remote fork "refs/heads/$BRANCH" | cut -f1)"

if [[ "$local_rev" == "$fork_rev" ]]; then
  exit 0
fi

# Never force: a fork tip this checkout does not contain means someone pushed from elsewhere.
if [[ -n "$fork_rev" ]] && ! git -C "$WORKTREE" merge-base --is-ancestor "$fork_rev" "$local_rev" 2>/dev/null; then
  echo "$(date '+%F %T') fork $BRANCH ($fork_rev) is not an ancestor of $local_rev; not pushing" >&2
  exit 1
fi

echo "$(date '+%F %T') pushing $BRANCH ${fork_rev:0:10} -> ${local_rev:0:10}"
GIT_TERMINAL_PROMPT=0 git -C "$WORKTREE" push --quiet fork "refs/heads/$BRANCH:refs/heads/$BRANCH"

# Best effort: an asleep or offline MacBook catches up on its own poll.
ssh -i "$MACBOOK_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 \
  -o StrictHostKeyChecking=accept-new "$MACBOOK" \
  "launchctl kickstart gui/\$(id -u)/$PULL_JOB" \
  && echo "$(date '+%F %T') kicked $PULL_JOB on $MACBOOK" \
  || echo "$(date '+%F %T') MacBook unreachable; it will pick ${local_rev:0:10} up on its next poll"
