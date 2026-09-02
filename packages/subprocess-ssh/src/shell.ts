/**
 * `ctx.shell` for a remote target — by reuse, not reimplementation.
 *
 * `LocalBashExecutor` declares `inject = ['subprocess']` and runs
 * `bash -c <command>` through the subprocess seam
 * (`packages/shell/bash-local/src/index.ts:102-103`). With this package's remote
 * subprocess provider mounted, that spawn lands on the TARGET unchanged — which
 * is the entire thesis of seam substitution, so re-exporting it is the correct
 * implementation rather than a shortcut.
 *
 * Why not the shipped `bash-sandbox` row? Because it calls
 * `ctx.sandbox.confine(['bash', '-c', command], policy)`
 * (`packages/shell/bash-sandbox/src/index.ts:178`), and `LocalSandboxProvider.confine`
 * rewrites argv to run under a HOST launcher — `bwrap`, `sandbox-exec`, or the
 * Windows ACL runner (`packages/sandbox/sandbox-local/src/index.ts:306-328`). Sent
 * to a remote target, that argv names programs and paths that do not exist there:
 * the command fails outright instead of merely running unfenced. The honest
 * composition is the unconfined executor plus an explicit statement that the
 * host's sandbox does not reach the target — the remote account's own permissions
 * are the fence there.
 *
 * This module exists at all because the base bundle depends on
 * `dsh-bash-sandbox` and `dsh-pwsh-sandbox` but NOT on `dsh-bash-local`
 * (`packages/bundle/base/package.json:49,71`), so a patch row cannot name that
 * package directly. Re-exporting it here puts it in the dependency closure.
 *
 * @module
 */

export { default, LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
