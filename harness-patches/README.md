# Harness patches (dsh-remote-ssh)

These changes belong to the **deployment's DeepSeek Harness fork** (upstream:
`deepseek-ai/deepseek-harness`); they are distributed here as git patches so
any machine running the same harness baseline can adopt them without copying
whole files.

- **Baseline harness commit**: `dd6322d604e00eec1ba5e0c8541159906a21094a` (master)
- **Patch 1**: `dsh-remote-ssh-route-labels.patch` — route-aware workspace/session labels for same-named remote directories.
- **Patch 2**: `dsh-remote-ssh-job-actions.patch` — a real **Stop** button for background jobs in the session header (jobs.kill from the browser).

Apply both with `git apply` (run `--check` first). Then rebuild the affected
client bundles: `packages/client/ui-workspace`, `packages/api/session-controller`,
and `packages/client/ui-jobs` (each: run the repo's `tsdown` inside the package),
then restart `dsh web`.

---

## Patch 1 — route-aware workspace/session labels

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

---

## Patch 2 — Stop button for session background jobs

The session-header job list was read-only (DSH renders jobs but nothing could
stop them from the page). This adds:

| File | Change |
|---|---|
| `packages/api/session-controller/src/index.ts` | new `@Remote('jobStop')` — looks up the owning session and calls `ctx.jobs.kill(jobId, caller, reason)`, so a browser Stop routes to the job's hooks (remote jobs: real process-group kill on the target). |
| `packages/client/ui-jobs/src/client/index.ts` | the header action is wrapped with a `stopJob` handler calling `session.jobStop`; on an unpatched host the button simply never renders. |
| `packages/client/ui-jobs/src/client/JobListAction.tsx` | live rows render a **Stop** button (disabled while a stop is pending; i18n `action.stop` / `action.stopping`). |
| `packages/client/ui-jobs/src/client/locales.ts` | `action.stop` / `action.stopping` in zh + en. |
| `packages/client/ui-jobs/src/client/JobListAction.module.css` | `.stop` row-button styling. |

Rebuild: `packages/client/ui-jobs` (tsdown), then restart `dsh web`. Stop on a
finished job is a no-op from the registry (`already-finished`); the row
settles through the normal jobs mirror.
