# Harness patches (dsh-remote-ssh)

These changes belong to the **deployment's DeepSeek Harness fork** (upstream:
`deepseek-ai/deepseek-harness`); they are distributed here as git patches so
any machine running the same harness baseline can adopt them without copying
whole files.

## Baselines

Both patches were originally cut against DSH 0.1.2-rc.1 and **re-cut against
DSH 0.1.5-rc.1** (2026-09-10): every file they touch was restructured
upstream, so the 0.1.2 cuts no longer apply.

| Patch | 0.1.2-rc.1 baseline | 0.1.5-rc.1 baseline |
|---|---|---|
| `dsh-remote-ssh-job-actions.patch` | `dd6322d6…` (legacy) | **`aa8262ec09…` (current)** ✅ |
| `dsh-remote-ssh-route-labels.patch` | `dd6322d6…` (legacy) | **`aa8262ec09…` (current)** ✅ |

- **Patch 1**: `dsh-remote-ssh-route-labels.patch` — route-aware workspace/session labels for same-named remote directories.
- **Patch 2**: `dsh-remote-ssh-job-actions.patch` — a real **Stop** button for background jobs in the session header (jobs.kill from the browser).

Apply with `git apply` (run `--check` first); the two are independent and can be
applied together. Then rebuild and restart `dsh web`:

```bash
pnpm run build:lib:host      # workspace, workspace-path, session-controller
pnpm run build:lib:client    # ui-workspace, ui-jobs (and peers)
```

> **0.1.5 notes.**
> * Patch 2 no longer needs `/jobstop` on the host — the added `session.jobStop`
>   Remote suffices; the client still prefers `/jobstop` when the plugin
>   registers it (dsh-remote-ssh does). `jobs.kill` is native in 0.1.5
>   (`packages/jobs/jobs-local`), so the patch only adds the browser trigger,
>   plus the `jobStop` entry the client-side fake API requires.
> * Patch 1 is smaller than its 0.1.2 cut: 0.1.5 centralizes default titles in
>   `defaultWorkspaceTitle()` (`workspace/src/paths.ts`), so one function now
>   covers both the create and re-group call sites that the old cut patched
>   separately in `workspace/src/index.ts`. `ui-workspace/tree.ts` is a
>   doc-comment update only (`workspaceLabel` already delegates to
>   `workspaceTitleOf`).

---

## Patch 1 — route-aware workspace/session labels

| File | Change |
|---|---|
| `packages/util/workspace-path/src/index.ts` | new `routePlaceholderSuffix()`; `workspaceTitleOf()` appends ` · <route>` for `…/dsh-ssh-routes/<id>/…` placeholder paths (client fallback labels, session display fallbacks) |
| `packages/workspace/workspace/src/paths.ts` | `defaultWorkspaceTitle()` gains `routeIdHuman()` (reads the plugin's secret-free route manifest: label → `user@host` → id) and a route suffix, so workspace **default titles** at create/re-group read e.g. `JunHeAssemblyLine · amax@192.168.10.125`. 0.1.5 funnels both call sites through this one function (`workspace/src/index.ts` is unpatched). |
| `packages/client/ui-workspace/src/client/tree.ts` | doc-only; the suffix logic lives in the util so `workspaceLabel` must not duplicate it |

Why server-side default titles: the list shows the durable workspace `title`
snapshot taken at create time, so a render-time label function alone cannot
fix already-created groups.

## Apply

> ⚠️ **These patches modify the DeepSeek Harness source tree**, not this plugin.
> Apply them only to a harness checkout you own, and re-verify them on every DSH
> upgrade — both patches were already invalidated once by the 0.1.2 → 0.1.5
> restructure. Nothing in this plugin's SSH capability depends on them: without
> the patches the plugin works, you just lose the route suffix on workspace
> titles and the Stop button in the job list.

```bash
HARNESS=<your harness checkout>
PATCHES=<this repo>/harness-patches

git -C "$HARNESS" apply --check "$PATCHES/dsh-remote-ssh-route-labels.patch"   # dry-run first
git -C "$HARNESS" apply --check "$PATCHES/dsh-remote-ssh-job-actions.patch"

git -C "$HARNESS" apply "$PATCHES/dsh-remote-ssh-route-labels.patch"
git -C "$HARNESS" apply "$PATCHES/dsh-remote-ssh-job-actions.patch"
```

## Rebuild (built artifacts are gitignored upstream)

The patches are source-only. Rebuild the affected halves from the harness
checkout, then restart the web instance:

```bash
cd "$HARNESS"
pnpm run build:lib:host      # workspace, workspace-path, session-controller
pnpm run build:lib:client    # ui-workspace, ui-jobs (and peers)
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
| `packages/api/session-controller/tests/fake-api.client.ts` | the generated remote namespace now requires a `jobStop` member, so the client-side fake API supplies one (otherwise the client typecheck fails). |
| `packages/client/ui-jobs/src/client/index.ts` | the header action is wrapped with a `stopJob` handler preferring the plugin's `/jobstop` command and falling back to `session.jobStop`; on an unpatched host the button simply never renders. |
| `packages/client/ui-jobs/src/client/JobListAction.tsx` | live rows render a **Stop** button (disabled while a stop is pending; i18n `action.stop` / `action.stopping`). |
| `packages/client/ui-jobs/src/client/locales.ts` | `action.stop` / `action.stopping` in zh + en. |
| `packages/client/ui-jobs/src/client/JobListAction.module.css` | `.stop` row-button styling. |

Rebuild with the commands above (`build:lib:host` covers session-controller;
`build:lib:client` covers ui-jobs), then restart `dsh web`. Stop on a finished
job is a no-op from the registry (`already-finished`); the row settles through
the normal jobs mirror.
