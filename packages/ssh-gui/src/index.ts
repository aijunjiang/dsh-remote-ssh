/**
 * dsh-ssh-gui — the user-layer half of dsh-remote-ssh.
 *
 * Forked from `UynajGI/dsh-ssh` (MIT) and trimmed to the GUI closure: the
 * connection registry, the `/dsh-ssh` RPC channel, the remote directory picker
 * backend, and the React client that fills dsh's workspace directory-flow slots.
 * The capability providers (filesystem, subprocess, search translation) are this
 * repository's own helper-backed packages, mounted alongside in the composition
 * patch.
 * @module dsh-ssh-gui
 */

export { SshRegistry } from './registry.ts'
export type { RegistryConfig, ConnectionInput, SshConnectionView, SshConfigHostView, ResolvedSshConfig, ResolvedJump } from './registry.ts'
export { SshConnection } from './connection.ts'
export type { SshConnectionSpec } from './connection.ts'
export { apply as applyWeb } from './web.ts'
export type { WebChannelConfig } from './web.ts'
export { SshDirectoryPicker } from './picker.ts'
export type { Config as PickerConfig } from './picker.ts'
export { apply } from './plugin.ts'
// The package ROOT is the loader row the composition mounts: client-modules
// only scans entries whose name resolves to a package ROOT (a subpath row such
// as `dsh-ssh-gui/web` is classified "not a client row" before resolution), so
// the plugin surface the root apply needs must ride the root module too.
export { inject, Config } from './web.ts'
