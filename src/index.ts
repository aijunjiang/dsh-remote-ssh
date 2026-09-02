/**
 * dsh-remote-ssh — official installable entry.
 *
 * The harness `dsh plugin add <spec>` path installs ONE self-contained package
 * whose manifest declares `dsh.bundle.patch`; that layer then applies at every
 * boot with no launch flag. This repository is a monorepo whose packages import
 * each other by relative path, so the official package IS the repository root:
 * pnpm materializes the whole tree, every relative import keeps resolving, and
 * the row the bundle patch mounts (`dsh-remote-ssh`) lands on this package root
 * — which also carries `dsh.client`, so client-modules serves the sidebar.
 *
 * The dev-tree aliases (packages/ssh-gui etc.) stay untouched for contributors.
 * @module dsh-remote-ssh
 */

export {
  SshRegistry,
  SshConnection,
  apply,
  applyWeb,
  inject,
  Config,
} from '../packages/ssh-gui/src/index.ts'

export type {
  RegistryConfig,
  ConnectionInput,
  SshConnectionView,
  SshConfigHostView,
  ResolvedSshConfig,
  ResolvedJump,
  SshConnectionSpec,
  WebChannelConfig,
} from '../packages/ssh-gui/src/index.ts'
