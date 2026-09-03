# Harness patches (dsh-remote-ssh)

Route-aware workspace/session labels for same-named remote directories.

These changes belong to the **deployment's DeepSeek Harness fork** (upstream:
`deepseek-ai/deepseek-harness`); they are distributed here as a git patch so
any machine running the same harness baseline can adopt them without copying
whole files.

- **Baseline harness commit**: `dd6322d604e00eec1ba5e0c8541159906a21094a` (master)
- **Patch**: `dsh-remote-ssh-route-labels.patch`

## What it changes (3 source files)

| File | Change |
|---|---|
| `packages/util/workspace-path/src/index.ts` | new `routePlaceholderSuffix()`; `workspaceTitleOf()` appends ` · <route>` for `…/dsh-ssh-routes/<id>/…` placeholder paths (client fallback labels, session display fallbacks) |
| `packages/workspace/workspace/src/index.ts` | new `routeIdHuman()` (reads the plugin's secret-free route manifest: label → `user@host` → id) and `routeAwareBasename()`; workspace **default titles** at create/re-group now read e.g. `JunHeAssemblyLine · amax@192.168.10.125` |
| `packages/client/ui-workspace/src/client/tree.ts` | doc-only; the suffix logic lives in the util so `workspaceLabel` must not duplicate it |

Why server-side default titles: the list shows the durable workspace `title`
snapshot taken at create time, so a render-time label function alone cannot
fix already-created groups.

## Apply

```bash
git -C <harness-checkout> apply --check dsh-remote-ssh-route-labels.patch
git -C <harness-checkout> apply dsh-remote-ssh-route-labels.patch
```

## Rebuild the client bundles (built artifacts are gitignored upstream)

The patch is source-only. Rebuild the two client bundles that inline the path
util, then restart the web instance:

```bash
# from the harness checkout:
node node_modules/tsdown/dist/run.mjs            # run inside packages/client/ui-workspace
node node_modules/tsdown/dist/run.mjs            # run inside packages/api/session-controller
# (or the monorepo's own bundle scripts for those packages)
```

## Verify

- Restart `dsh web` (no launch flags needed).
- Open a remote route workspace: its group title reads
  `directory-name · <label|user@host>`.
- Same-named directories on different hosts no longer look identical.

Regenerate after upstream changes:
`git -C <harness> diff <baseline>..HEAD -- packages/util/workspace-path packages/workspace/workspace packages/client/ui-workspace/src/client/tree.ts`
