# Custom Hermes desktop (heemang-parmar/hermes-agent)

Local customisations of the Hermes desktop app, carried on top of upstream
`NousResearch/hermes-agent`.

This document is the operational manual for the custom desktop line: what is
carried, how to build it, how to take a further upstream update, and how to roll
back. It describes the **merge candidate** workflow. Read the "Channels" section
before running any updater — the stock `hermes update` will replace a custom app.

## Current state

| Field | Value |
| --- | --- |
| Integration branch | `custom/desktop-merge-into-main` |
| Custom tip it merges | `custom/desktop` @ `29629c4933` |
| Upstream snapshot examined | `601491feb3` (2026-10-20) |
| Merge commit | `a421de8ebe` (parents `29629c4933 601491feb3`) |
| Merge type | true merge, **no rebase, no history rewrite** |
| Conflicts resolved | 1 (`apps/desktop/src/plugins/hermes-bots/i18n.ts`) |

`601491feb3` is the **tip of upstream `main`**, not a release. It sits **2579
commits ahead of the latest stable tag `v0.22.2`** (released 2026-10-15), and
`v0.22.2` is an ancestor of it. The snapshot is pinned deliberately so the build
is deterministic: do not "helpfully" re-point the merge at a newer `main` in the
middle of a verification run.

### Channels: read this before running any updater

Upstream source checkouts **default to the stable channel** — the latest published
`vX.Y.Z` release, never a canary or prerelease tag. Following every commit on
`main` requires an explicit opt-in (`hermes update --set-channel main`), stored
per install in `config.yaml` under `update.installs`.

Consequences for this custom line:

- **Do not run `hermes update` against a custom desktop checkout and expect it to
  keep your app.** The stock updater rebuilds and re-installs the desktop bundle
  from the checkout it manages. Against a custom branch that either replaces the
  custom app with a stock build, or — under `updates.parked_branch_strategy:
  update_in_place` — merges `origin/main` into your branch on its own schedule,
  which is a different operation from the reviewed merge below.
- The custom app is updated by the **merge workflow in this document**, not by
  the stock updater.
- The **backend** (gateways, `hermes serve`) runs from the main checkout
  `~/.hermes/hermes-agent` and is updated separately with `hermes update`. Keep it
  on a nearby upstream revision so app and backend do not drift.
- Upstream's own updater pauses running gateways immediately before it first
  changes a checkout, and restarts them once dependencies are prepared. **No live
  upgrade or restart has been performed in this integration** — the candidate is
  built and committed locally only.

## Where desktop changes go

**Only here:** the `custom/desktop` worktree at `~/.hermes/hermes-desktop-custom`,
committed on `custom/desktop` and pushed to the `fork` remote.

**Never as uncommitted edits in `~/.hermes/hermes-agent`** (the main checkout that
runs the gateways). The desktop app is built from the desktop worktree, so edits
left in the main checkout are silently missing from the next build. `hermes
update` also autostashes them. This already happened once, to the bot-row
designation change.

## Build / relaunch

```bash
~/.hermes/hermes-desktop-custom/custom/build-desktop.sh            # build only
~/.hermes/hermes-desktop-custom/custom/build-desktop.sh --relaunch # build + swap the running app
```

The script refuses to build while uncommitted desktop edits exist in the main
checkout or in that worktree.

A build of the merge candidate happens in its own worktree and needs a full root
install, because the desktop workspace hoists its dependencies to the repo root:

```bash
cd ~/.hermes-integration/hermes-agent-integration
npm ci                                    # locked, from package-lock.json
cd apps/desktop
npm run typecheck                         # tsc across app, electron, e2e, builder config
npm run lint                              # eslint src/ electron/
npx vitest run --project ui               # renderer unit suite
npx vitest run --project electron         # main-process + script suite
npm run build                             # renderer + electron bundle
npm run pack -- --publish never           # unpacked .app in apps/desktop/release/
```

`npm run pack` never installs over `/Applications`; the artifact stays in
`apps/desktop/release/mac-arm64/Hermes.app` until you explicitly swap it.

## Taking a further upstream update

```bash
cd ~/.hermes-integration/hermes-agent-integration
git fetch origin main
git merge <new-main-sha>                  # true merge; never rebase the custom line
# resolve conflicts, then run the full gate set above before committing
git push fork custom/desktop-merge-into-main
```

Pin the upstream SHA you actually examined. A moving `origin/main` makes a merge
non-reproducible and turns a green gate run into a claim about a commit that was
never tested.

Merge conflicts are expected: the custom line touches `apps/desktop` heavily.
Expect at minimum the Bots i18n surface — upstream extracts `BotsMessages` into
`apps/desktop/src/plugins/hermes-bots/i18n-messages.ts`, so every custom key
(`org`, `sections` extensions, `pinned`, `collapseAll`, `expandAll`, `colorName`, …)
must be carried into the extracted file rather than left in `i18n.ts`.

## Rollback

Every step is local and reversible; nothing was pushed and nothing live was
restarted.

```bash
# discard the candidate branch entirely
git -C ~/.hermes-integration/hermes-agent-integration checkout custom/desktop
git -C ~/.hermes-integration/hermes-agent-integration branch -D custom/desktop-merge-into-main
git -C ~/.hermes/hermes-agent worktree remove --force .hermes-integration/hermes-agent-integration

# restore a single pre-existing file
cp ~/.hermes-integration/backups/voice-caption-repro.original.test.ts \
   ~/.hermes/hermes-desktop-custom/apps/desktop/src/store/voice-caption-repro.test.ts
```

Checksum-verified backups of every file that arrived pending live at
`~/.hermes-integration/backups/` (mode-500 directory), with the manifest and
checksums one level up in `~/.hermes-integration/MANIFEST.md` and
`CHECKSUMS.txt`.

## Carried changes

Sixteen custom commits sit on top of upstream, in `git log 0e427d788d..29629c4933`.

**Bots roster**

1. Nested sections (subfolders) in the Bots roster.
2. A fixed designation under the bot name instead of the latest-message preview.
3. Section colours, and an org chart laid out like one.
4. Shared-department sections, with synced section looks and navy.
5. Collapse/expand all sections, and a Pinned block on top.
6. An org chart tab — the roster's sections rendered as a hierarchy.
7. Talk to a bot from the org chart.
8. The org chart no longer leaves out a connection's bare default profile.

**Profiles, sessions, avatars**

9. Profile avatars in the profile switcher and the Profile filter.
10. The Sessions Profile filter shows profile display names.
11. A Bot chat opened in place speaks with the Bot's own profile.

**Voice**

12. Live GPT-Live captions in the chat thread.
13. GPT-Live speaks as the profile it dials, not as Hermes.
14. An org chart call actually starts its session.

**Tooling**

15. Restore the ProfileGlyph grapheme and default-mark tests.
16. A guarded desktop build script and the where-to-edit notes (this file).

**Branding and sync**

17. Cached roster avatars follow the server: `profiles.list` reports `avatar_rev`, and the
    roster re-pulls an avatar whenever the rev moves, so a pfp changed on one machine shows
    on every other one instead of the first cached copy sticking forever.
18. The app is "Hermes (Custom)": its own icon set (`apps/desktop/assets/icon*`,
    `icon.icon/`) and `CFBundleName`/`CFBundleDisplayName`. `productName`, the executable
    and userData stay "Hermes", so settings, connections and permissions carry over.
    `build-desktop.sh --relaunch` installs it as `/Applications/Hermes (Custom).app`.
19. Studio -> MacBook auto-sync (below).

## Keeping the MacBook in sync

Commits on `custom/desktop` reach the MacBook Pro by themselves:

- **Studio** — `com.hermes.custom-sync-push` (launchd, every 2 min) runs `sync-push.sh`:
  when the branch has commits the `fork` remote lacks it fast-forward-pushes them, then kicks
  the MacBook's pull job over SSH (`~/.ssh/hermes_macbook_ed25519`).
- **MacBook** — `com.hermes.custom-sync-pull` (launchd, every 15 min and on that kick) runs
  `sync-pull.sh`: fast-forwards from the fork, `npm ci` when `package-lock.json` moved,
  then `build-desktop.sh --relaunch`. The last built commit is stamped in
  `~/Library/Application Support/hermes-custom-sync/built-rev`; a failed build retries.

Only committed work travels, and neither side ever forces: a diverged branch stops the sync
and logs why. Logs: `/tmp/hermes-custom-sync-{push,pull}.log`. Install or reinstall a job:

```bash
cp custom/launchd/com.hermes.custom-sync-push.plist ~/Library/LaunchAgents/   # Studio
cp custom/launchd/com.hermes.custom-sync-pull.plist ~/Library/LaunchAgents/   # MacBook
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hermes.custom-sync-<role>.plist
```

The backend half of the avatar fix (`tui_gateway/methods_profiles.py`) must also be in the main
checkout that serves the roster (`~/.hermes/hermes-agent` on the Studio); until it is, rows
carry no `avatar_rev` and the roster keeps its old cache-forever behaviour.

## Pinned regressions

These pending test files arrived as untracked work and are now committed with the
production behaviour they describe:

- `tests/hermes_cli/test_model_picker_global_root_fallback.py` — the model
  picker under a **named profile** must see a provider authenticated only at the
  **global root**. Backed by
  `_auth_store_has_provider()` / `_raw_pool_usable()` in
  `hermes_cli/model_switch_providers.py`, which now use the same profile→root
  shadowing that `read_credential_pool()` and `get_provider_auth_state()`
  already had.
- `tests/hermes_cli/test_provider_models_cache_inherits_root.py` — a profile
  borrowing the root's credential inherits the root's **same-fingerprint**
  `provider_models_cache.json` row instead of collapsing to the curated
  15-slug fallback. Backed by `_inherited_global_cache_entry()` in
  `hermes_cli/models.py`. Read-only, classic-mode no-op, rejected on
  fingerprint mismatch, and never inherited by a profile that owns its own
  credential-pool row.
- `apps/desktop/src/store/voice-caption-repro.test.ts` — the GPT-Live caption
  fragmentation repro. Asserts exact caption text, speaker and anchor, including
  the delegation path (`promoteVoiceCaptionsToTurn` drops the user's caption and
  mutes the voice's reply). Its pre-reconciliation original is preserved verbatim
  at
  `apps/desktop/src/store/__archive__/voice-caption-repro.original.ts.txt` —
  the `.ts.txt` name keeps it out of every vitest include glob, so the archive can
  never sit red in the suite.

### Why profile boundaries still hold

The fallbacks above are deliberately narrow, and the tests that pin them also pin
the refusal cases:

- A profile-local entry always **shadows** the root's, for the same provider.
- In classic mode (`HERMES_HOME` *is* the platform-default root) there is no
  separate global layer, and both fallbacks are no-ops.
- A profile that owns its own `credential_pool` row for a provider **never**
  inherits — its credentials resolve to a different catalog.
- A fingerprint mismatch is rejected: a different principal is a different
  catalog, and serving the root's would be wrong.