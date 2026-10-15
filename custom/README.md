# Custom Hermes desktop (heemang-parmar/hermes-agent, branch `custom/desktop`)

Local customisations of the Hermes desktop app, carried on top of upstream
`NousResearch/hermes-agent` `main`.

## Where desktop changes go

**Only here:** the `custom/desktop` worktree at `~/.hermes/hermes-desktop-custom`,
committed on `custom/desktop` and pushed to the `fork` remote.

**Never as uncommitted edits in `~/.hermes/hermes-agent`** (the main checkout that
runs the gateways). The desktop app is built from this worktree, so edits left
there are silently missing from the next build. `hermes update` also autostashes
them. This already happened once, to the bot-row designation change.

## Build / relaunch

```bash
~/.hermes/hermes-desktop-custom/custom/build-desktop.sh            # build only
~/.hermes/hermes-desktop-custom/custom/build-desktop.sh --relaunch # build + swap the running app
```

The script refuses to build while uncommitted desktop edits exist in the main
checkout or in this worktree.

## Taking an upstream update

```bash
cd ~/.hermes/hermes-desktop-custom
git fetch origin main
git rebase origin/main          # replay the custom commits; resolve conflicts if any
# run the bots tests, then:
custom/build-desktop.sh --relaunch
git push --force-with-lease fork custom/desktop
```

The backend (gateways, `hermes serve`) keeps running from the main checkout and
is updated with `hermes update` as usual. Keep both on a similar upstream
revision so the app and the backend do not drift apart.

## Carried changes

- Nested sections (subfolders) in the Bots roster.
- Fixed designation under the bot name instead of the latest-message preview.
