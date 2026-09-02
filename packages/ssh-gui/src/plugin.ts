/**
 * GUI-layer plugin for dsh-remote-ssh: mounts the connection registry and the
 * `/dsh-ssh` RPC channel that the client sidebar and directory browser drive.
 *
 * This is the USER-LAYER half of the remote-workspace story, forked from
 * `UynajGI/dsh-ssh` (MIT). It provides, in the dsh web GUI:
 *
 *  * a connection sidebar — saved connections, `~/.ssh/config` hosts, and a
 *    local entry;
 *  * add / test / remove connections (password, key, or agent auth; ProxyJump
 *    chains);
 *  * remote directory browsing and mkdir;
 *  * `ssh://<id>/<path>` routing, the session-level "this session is on that
 *    machine" switch.
 *
 * Deliberately NOT mounted here: the directory picker row (`dsh-ssh-gui/picker`),
 * which replaces dsh's default add-workspace chooser. It injects `ctx.ssh` with
 * the upstream connection owner's interface (`getSftp`/`endpoint`), and that
 * interface is unified in the helper-connection step; the picker row joins the
 * composition then.
 *
 * @module dsh-ssh-gui
 */

import type { Context } from '@deepseek-ai/cordis'
import { apply as applyWeb } from './web.ts'
import type { WebChannelConfig } from './web.ts'

/**
 * Mount the GUI layer.
 * @param ctx - the mounting Cordis context.
 * @param config - state-file location and listing bound.
 */
export function apply(ctx: Context, config: WebChannelConfig): void {
  applyWeb(ctx, config)
}
