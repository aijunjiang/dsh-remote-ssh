/**
 * Browser half of dsh-ssh: the add-workspace directory flow — a connection
 * sidebar (saved connections, `~/.ssh/config` hosts, local entry) beside the
 * directory browser. Registered into both directory-flow holes, so mounting
 * `dsh-ssh` composes the whole picking interaction. Cross-plane calls ride the
 * shared web transport: local listing through the `uiWorkspace` service (the
 * Host's `directoryPicker` browse capability) and remote listing/connection
 * management through the package's `/dsh-ssh` RPC channel.
 *
 * When dsh-better-sidebar is installed, a "Remote Files" tab is registered
 * that browses remote hosts over SFTP. Without better-sidebar, the tab is
 * silently skipped — remote-ssh works unchanged.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteFileBrowser } from './RemoteFileTree.tsx'
import { SshWorkspaceFlow } from './flow.tsx'

/** Local, self-contained wire contracts (no cross-plugin value imports). */
export interface WireEntry {
  name: string
  path: string
  hidden: boolean
}

export interface WireListing {
  path: string
  home: string
  crumbs: WireEntry[]
  entries: WireEntry[]
  truncated: boolean
}

export interface ConnectionView {
  id: string
  label: string
  host: string
  port: number
  username: string
  cwd?: string
  auth: 'password' | 'key' | 'agent'
  jumpHosts: string[]
}

/** One exact `~/.ssh/config` Host alias (the `config.hosts` wire row). */
export interface ConfigHostView {
  alias: string
  host: string
  username: string
  port: number
  identityFile: boolean
  jump: boolean
}

export type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

/** The ui-workspace client service's directory faces (listDirectory/createDirectory). */
export interface ClientUiWorkspace {
  listDirectory(path?: string, signal?: AbortSignal): Promise<WireListing>
  createDirectory(path: string, name: string): Promise<string>
}

/** The client connection handle's RPC face. */
export interface ClientConnection {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WireResult>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
      register(options: { name: string; inject?: (...args: never[]) => Record<string, unknown> }, component: unknown): () => void
    }
    uiWorkspace: ClientUiWorkspace
    /** Optional: dsh-better-sidebar's service, available when the plugin is installed. */
    betterSidebar?: {
      registerTab(descriptor: {
        id: string
        type: string
        title: string
        icon?: unknown
        component: () => unknown
        badge?: { text: string; color?: string }
      }): () => void
      registerFileViewer(descriptor: {
        id: string
        extensions: string[]
        label: string
        component: (props: { path: string; content: string; mimeType: string }) => unknown
      }): () => void
      openTab(params: { type: string; title: string; id: string }): void
    }
  }
}

/** Required client services: the slot registry and the wire-facing workspace browser service. */
export const inject = ['slots', 'uiWorkspace']

/**
 * Client plugin body: fill both directory-flow holes with the SSH workspace
 * flow. `slots.inject` waits for each hole's declaration, and the generator
 * installs the two registrations transactionally.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const injected = (): Record<string, unknown> => ({
    listLocalDirectory: (path?: string, signal?: AbortSignal) => ctx.uiWorkspace.listDirectory(path, signal),
    createLocalDirectory: (path: string, name: string) => ctx.uiWorkspace.createDirectory(path, name),
    rpc: (endpoint: string, payload?: unknown, signal?: AbortSignal) => {
      const connection = ctx.get('connection') as ClientConnection | undefined
      if (connection === undefined) {
        return Promise.resolve({ ok: false, error: { code: 'internal', message: 'dsh-ssh: the web transport is not available' } } as WireResult)
      }
      return connection.rpc.call('/dsh-ssh', endpoint, payload ?? {}, signal)
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, SshWorkspaceFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, SshWorkspaceFlow)
    }))

  // ── better-sidebar integration ──────────────────────────────────────
  // When dsh-better-sidebar is installed, register a "Remote Files" tab
  // that browses the remote host over SFTP. Without better-sidebar, the
  // service is undefined and this block is a no-op — remote-ssh's
  // existing connection manager and workspace picker are unaffected.
  //
  // Use ctx.get() instead of ctx.betterSidebar: cordis requires services
  // accessed via property to be declared in the inject list, and
  // better-sidebar is an optional peer — ctx.get() returns undefined
  // when the service is absent instead of throwing.
  const sidebar = ctx.get('betterSidebar') as Context['betterSidebar']
  if (sidebar !== undefined) {
    ctx.effect(() => {
      const rpc = (endpoint: string, payload?: unknown, signal?: AbortSignal) => {
        const connection = ctx.get('connection') as ClientConnection | undefined
        if (connection === undefined) {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: 'dsh-ssh: transport unavailable' } } as WireResult)
        }
        return connection.rpc.call('/dsh-ssh', endpoint, (payload ?? {}) as Record<string, unknown>, signal)
      }

      const disposeTab = sidebar.registerTab({
        id: 'dsh-remote-ssh:remote-files',
        type: 'dsh-remote-ssh:remote-files',
        title: 'Remote Files',
        component: () => RemoteFileBrowser({ rpc }),
      })

      return () => { disposeTab() }
    }, 'dsh-ssh: better-sidebar remote-files tab')
  }
}
