/**
 * The agent-facing surface of dsh-ssh-gui, installed alongside the `/dsh-ssh`
 * RPC channel:
 *
 *  1. P0-1 — a runtime-context block naming the session's SSH route (or, when
 *     the route spells but does not resolve, a DEGRADED warning instead of
 *     silence — never let a model read an offline mirror as an empty project);
 *  2. P1-5 — `DSH_SSH_*` environment variables for routed shell executions;
 *  3. P0-2 — the `ssh_exec` model tool (in-process ssh2/helper channel, no host
 *     ssh.exe), with errors that distinguish route-local from route-missing
 *     and always list the known connections as a recovery path;
 *  4. P1-4 — `ssh_route_status`: route identity, the secret-free manifest path,
 *     every known connection, and an optional live probe.
 *
 * All registrations are no-ops for sessions that do not name an SSH route,
 * except that a route-spelled-but-unresolvable cwd now renders an explicit
 * degraded notice (the number-one "silent wrong answer" hazard from field
 * feedback).
 * @module dsh-ssh-gui/agent-experience
 */

import type { Context } from '@deepseek-ai/cordis'
import { SshHelperRouter } from './helper-router.ts'
import { SshHelperError, SshTransportError } from '../../ssh/src/channel.ts'
import { runRemoteCommand } from './remote-exec.ts'
import { routesManifestPath } from './routes-manifest.ts'
import {
  degradedRouteText,
  parseRoutedCwd,
  routeEnvironment,
  routeFactsFor,
  routeIdentityText,
  type RouteFacts,
} from './route-facts.ts'
import type { SshConnection } from './connection.ts'

// -- minimal structural views of optional host services (cast at the seams) --

interface SessionLike {
  header: { cwd?: string }
}

interface SessionsLike {
  get(id: unknown): SessionLike | undefined
}

/** A secret-free registry view (the real SshRegistry.list() shape). */
interface ConnectionViewLike {
  id: string
  label?: string
  host: string
  port: number
  username: string
}

interface RegistryLike {
  get(id: string): SshConnection | undefined
  list(): ConnectionViewLike[]
  stateFilePath?: string
}

interface AgentLike {
  id?: unknown
  session?: SessionLike
}

interface ExecutionLike {
  agent?: AgentLike
  signal: AbortSignal
}

interface SystemPromptLike {
  context(registration: {
    name: string
    order: number
    text: string | ((context: { agent?: AgentLike }) => string)
  }): () => void
}

interface ShellEnvLike {
  register(contributor: {
    name: string
    variables: Record<string, { description: string }>
    resolve(execution: ExecutionLike): Partial<Record<string, string>>
  }): () => void
}

interface ToolLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: string }
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
  }
  timeoutMs?: number
  execute(args: unknown, exec: ExecutionLike): Promise<string>
}

interface ToolsLike {
  register(definition: ToolLike): () => void
}

/** Tool schema names. */
export const SSH_EXEC_TOOL = 'ssh_exec'
export const SSH_ROUTE_STATUS_TOOL = 'ssh_route_status'

/** The runtime-context block names. */
export const ROUTE_CONTEXT_NAME = 'ssh:route'
export const USAGE_CONTEXT_NAME = 'ssh:usage'

/** Ordering after the harness's own runtime contexts (sandbox 110, approval 115, delegation 120). */
const ROUTE_CONTEXT_ORDER = 130
const USAGE_CONTEXT_ORDER = 131

/** How a route-spelled cwd failed to resolve, for message triage. */
export type RouteDegradeReason = 'no-registry' | 'unknown-connection'

/** One agent's routing situation, resolved without any network access. */
export type SessionRouteView =
  | { kind: 'local' }
  | { kind: 'degraded'; id: string; path: string; reason: RouteDegradeReason }
  | { kind: 'route'; facts: RouteFacts; connection: SshConnection }

/**
 * Session working directory for one agent. Prompt assembly hands context a
 * full agent carrying `.session`; tool execution hands the tools layer an
 * id-only agent, so the live session store is the fallback.
 */
function agentSessionCwd(sessions: SessionsLike | undefined, agent: AgentLike | undefined): string | undefined {
  if (agent === undefined) return undefined
  const direct = agent.session?.header.cwd
  if (direct !== undefined) return direct
  const id = agent.id
  if (id === undefined) return undefined
  return sessions?.get(id)?.header.cwd
}

/** Human-readable failure reason for message triage. */
function degradeReasonText(reason: RouteDegradeReason): string {
  return reason === 'no-registry'
    ? 'the dsh-ssh-gui connection registry is not mounted in this host'
    : 'the registry has no live entry for it (removed or offline)'
}

/** Resolve the session routing situation for one agent. */
function routeViewFor(
  sessions: SessionsLike | undefined,
  registry: RegistryLike | undefined,
  agent: AgentLike | undefined,
): SessionRouteView {
  const cwd = agentSessionCwd(sessions, agent)
  const routed = parseRoutedCwd(cwd)
  if (routed === null) return { kind: 'local' }
  if (registry === undefined) return { kind: 'degraded', ...routed, reason: 'no-registry' }
  const connection = registry.get(routed.id)
  const facts = connection === undefined ? null : routeFactsFor(connection, routed)
  if (connection === undefined || facts === null) {
    return { kind: 'degraded', ...routed, reason: 'unknown-connection' }
  }
  return { kind: 'route', facts, connection }
}

/** The context text for one routing situation ('' hides the block). */
function routeContextText(view: SessionRouteView): string {
  switch (view.kind) {
    case 'local': return ''
    case 'route': return routeIdentityText(view.facts)
    case 'degraded': return degradedRouteText(view.id, view.path, degradeReasonText(view.reason))
  }
}

/**
 * Which world the mounted capability providers name, probed structurally from
 * the registered services (best effort; never throws). The ssh-gui host knows
 * nothing about the provider rows another patch may have mounted, so the agent
 * guide must adapt to both shapes: full patch (fs/subprocess ARE remote) and
 * GUI-only (they are local and ssh_exec is the only remote channel).
 */
export type RemoteWorld = 'remote' | 'local'

export function remoteWorldOf(ctx: Context): RemoteWorld {
  const sshNamed = (name: string): boolean => {
    try {
      const service = ctx.get(name) as { constructor?: { name?: string } } | undefined
      if (service === undefined) return false
      return /ssh|remote/i.test(service.constructor?.name ?? '')
    } catch {
      return false
    }
  }
  return sshNamed('subprocess') || sshNamed('fs') ? 'remote' : 'local'
}

/** The routing guide rendered into the runtime context for routed sessions. */
function usageContextText(facts: RouteFacts, world: RemoteWorld): string {
  const channel = world === 'remote'
    ? 'Your file and shell tools (read/write/glob/grep/edit/bash) run ON this remote host through the mounted SSH providers.'
    : 'The SSH capability providers are NOT mounted in this instance: your file and shell tools still touch the LOCAL machine, and the dsh-ssh-routes/… directories are empty placeholders — never report them as an "empty project". Use ssh_exec to run commands on the route host.'
  return [
    'Working in this SSH session:',
    `- Route \`${facts.id}\` → ${facts.username}@${facts.host} (remote cwd ${facts.path}). ${channel}`,
    '- Run remote commands with ssh_exec: pass the WHOLE script as one `command` string (no local quoting layer), locale is fixed to C, output is capped and truncation is marked. Do NOT hand-roll a local ssh.exe/ssh call — on Windows confined sessions it cannot spawn and wastes turns/approvals.',
    '- Never treat mirrored dsh-ssh-routes/<id>/... contents as project truth: they are placeholders. Read/write through the remote world (ssh_exec, or the remote file tools when the providers are mounted).',
    '- The remote world is fenced by the remote account\'s own permissions only — no local sandbox applies on the target. Host-local concerns (approval, credentials, GUI, $DSH_HOME) still live on this machine.',
    '- If a route errors or files look gone: run ssh_route_status (lists known connections and the manifest path), have the connection re-added/tested in the sidebar, then retry. Never guess the target by enumerating ~/.ssh/config.',
    '- Routed shell executions carry DSH_SSH_ROUTE_ID/HOST/USER/PORT/REMOTE_CWD — prefer DSH_SSH_REMOTE_CWD over path guessing.',
  ].join('\n')
}

/** List every known connection as recovery guidance (`known connections: …`). */
function knownConnectionsText(registry: RegistryLike | undefined): string {
  const views = registry?.list() ?? []
  if (views.length === 0) return 'Known connections: (none registered yet — add one in the sidebar Connections pane).'
  const names = views.map(view => {
    const port = view.port !== 22 ? `:${view.port}` : ''
    return `\`${view.id}\` (${view.username}@${view.host}${port})`
  })
  return `Known connections: ${names.join(', ')}.`
}

/** Where the human-readable route manifest lives, when determinable. */
function manifestHint(registry: RegistryLike | undefined): string {
  const path = registry?.stateFilePath
  return path === undefined
    ? 'no route manifest yet (the connection registry is not mounted here)'
    : `route manifest: ${routesManifestPath(path)}`
}

/** Render one non-error `ssh_exec` outcome as model-facing text. */
function renderResult(result: Awaited<ReturnType<typeof runRemoteCommand>>): string {
  const head: string[] = []
  if (result.timedOut) head.push('[timed out; process group terminated]')
  const exit = result.exitCode === null
    ? `exit: ${result.signal === null ? '(terminated)' : `signal ${result.signal}`}`
    : `exit: ${result.exitCode}`
  const pid = result.pid > 0 ? `pid ${result.pid} pgid ${result.pgid}` : 'process never started'
  head.push(`ssh_exec ${exit} (${pid})`)
  const body: string[] = []
  if (result.stdout.length > 0) body.push(result.stdout.trimEnd())
  else if (result.stderr.length === 0) body.push('(no output)')
  if (result.truncatedOut) body.push('[stdout truncated at the remote-exec cap]')
  if (result.stderr.length > 0) body.push(result.stderr.trimEnd())
  if (result.truncatedErr) body.push('[stderr truncated at the remote-exec cap]')
  return `${head.join('\n')}${body.length === 0 ? '' : `\n${body.join('\n')}`}`
}

/** Map a remote failure onto explicit model-facing text (coded, never blank). */
function failureText(error: unknown): string {
  if (error instanceof SshHelperError) {
    return `ssh_exec failed [${error.code}]: ${error.message.replace(/^dsh-ssh: /u, '')}`
  }
  if (error instanceof SshTransportError) {
    const message = error.message.replace(/^dsh-ssh: /u, '')
    if (/failed to start the remote helper/u.test(message)) {
      return `ssh_exec: the remote helper did not start (${message})`
    }
    return `ssh_exec failed [transport]: ${message}`
  }
  return `ssh_exec failed: ${error instanceof Error ? error.message : String(error)}`
}

/** Options accepted by `ssh_exec`. */
interface SshExecArgs {
  command?: unknown
  cwd?: unknown
  timeoutMs?: unknown
}

/** Options accepted by `ssh_route_status`. */
interface RouteStatusArgs {
  checkLive?: unknown
}

/**
 * Execute one `ssh_exec` call against the session's route.
 * @returns model-facing text; never throws for business outcomes.
 */
async function executeSshExec(
  sessions: SessionsLike | undefined,
  registry: RegistryLike | undefined,
  router: SshHelperRouter,
  args: SshExecArgs,
  exec: ExecutionLike,
): Promise<string> {
  const command = typeof args.command === 'string' && args.command.trim() !== ''
    ? args.command
    : undefined
  if (command === undefined) {
    return 'ssh_exec: `command` must be a non-empty string; nothing was executed.'
  }

  const view = routeViewFor(sessions, registry, exec.agent)
  if (view.kind === 'local') {
    return 'ssh_exec: this session is not on an SSH route (its working directory does not spell `ssh://<id>/<path>` or a dsh-ssh-routes placeholder); nothing was executed. '
      + 'If you expected a remote session, ask the user to open a session inside the SSH route workspace.'
      + ` ${knownConnectionsText(registry)} ${manifestHint(registry)}`
  }
  if (view.kind === 'degraded') {
    return `ssh_exec: route \`${view.id}\` spells remote path ${view.path}, but it is NOT resolvable: ${degradeReasonText(view.reason)}. `
      + 'Nothing was executed, and any mirrored directory under the session cwd is NOT authoritative. '
      + `Reconnect or re-add the route (sidebar Connections → Test), then retry. ${knownConnectionsText(registry)} ${manifestHint(registry)}`
  }

  // Remote base: an explicit absolute POSIX override, else the route path.
  const requested = typeof args.cwd === 'string' && args.cwd.startsWith('/') ? args.cwd : undefined
  const base = requested ?? view.facts.path

  const requestedTimeout = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
    ? Math.max(1_000, Math.min(600_000, Math.trunc(args.timeoutMs)))
    : 120_000
  let signal: AbortSignal = exec.signal
  try {
    signal = AbortSignal.any([exec.signal, AbortSignal.timeout(requestedTimeout)])
  } catch {
    signal = exec.signal
  }

  let session
  try {
    session = router.sessionForId(view.facts.id)
  } catch (error) {
    return failureText(error)
  }
  try {
    const result = await runRemoteCommand(session, { command, cwd: base, signal })
    return renderResult(result)
  } catch (error) {
    return `${failureText(error)} (if the route is offline, reconnect it first; see ssh_route_status)`
  }
}

/**
 * Report the session's routing situation (P1-4 recovery tool).
 * @param checkLive - when truthy, dial the connection and run `true` to prove
 *   the route is reachable right now (touches the network; default off).
 */
async function executeRouteStatus(
  sessions: SessionsLike | undefined,
  registry: RegistryLike | undefined,
  args: RouteStatusArgs,
  exec: ExecutionLike,
): Promise<string> {
  const view = routeViewFor(sessions, registry, exec.agent)
  const lines: string[] = []
  const known = knownConnectionsText(registry)
  switch (view.kind) {
    case 'local': {
      lines.push('This session is NOT on an SSH route — its working directory is local.')
      lines.push('To work on a remote host, open a session whose cwd is inside the SSH route workspace'
        + ' (sidebar "choose workspace directory" → a routed entry), then ssh_exec/ssh_route_status apply here.')
      lines.push(known)
      lines.push(manifestHint(registry))
      return lines.join('\n')
    }
    case 'degraded': {
      lines.push(`Session cwd spells SSH route \`${view.id}\` (remote path ${view.path}) — DEGRADED: ${degradeReasonText(view.reason)}.`)
      lines.push('Mirrored directories under the session cwd are NOT authoritative until the route resolves.')
      lines.push('Fix: reconnect or re-add the route (sidebar Connections), then retry ssh_exec.')
      lines.push(known)
      lines.push(manifestHint(registry))
      return lines.join('\n')
    }
    case 'route': {
      const port = view.facts.port !== 22 ? `:${view.facts.port}` : ''
      lines.push(`Session is on SSH route \`${view.facts.id}\` → ${view.facts.username}@${view.facts.host}${port} (${view.facts.label ?? 'no label'})`)
      lines.push(`Remote working directory: ${view.facts.path}`)
      lines.push(known)
      lines.push(manifestHint(registry))
      if (args.checkLive === true) {
        const signal = exec.signal
        try {
          await view.connection.getClient(signal)
          const outcome = await view.connection.exec('true', { signal })
          const verdict = outcome.exitCode === 0
            ? 'reachable'
            : 'reachable but the probe command exited ' + String(outcome.exitCode)
          lines.push(`Live probe: ${verdict}`)
        } catch (error) {
          lines.push(`Live probe FAILED: ${error instanceof Error ? error.message : String(error)} (reconnect the route first)`)
        }
      } else {
        lines.push('Pass checkLive: true to probe reachability now (touches the network).')
      }
      return lines.join('\n')
    }
  }
}

/**
 * Install the agent-facing registrations. Each service is optional: mounts
 * without `systemPrompt`/`shellEnv`/`tools`/`sessions`/`sshRegistry` simply
 * skip the corresponding contribution, which keeps tests and partial
 * compositions harmless.
 * @param ctx - the mounting Cordis context (the web channel's host ctx).
 */
export function installAgentExperience(ctx: Context): void {
  const disposers: Array<() => void> = []
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'ssh-agent-experience: dispose')

  // Services must be read LAZILY, not captured at install: ctx.plugin(SshRegistry)
  // (and the capability providers) mount through a fiber, so they may not be
  // visible yet when apply runs. A once-captured `undefined` here silently
  // degraded every routed session ("registry not mounted") — exactly the field
  // bug this lazy access fixes.
  const sessionsOf = (): SessionsLike | undefined => ctx.get('sessions') as SessionsLike | undefined
  const registryOf = (): RegistryLike | undefined => ctx.get('sshRegistry') as RegistryLike | undefined
  const router = new SshHelperRouter(ctx)
  ctx.effect(() => () => { void router.dispose() }, 'ssh-agent-experience: helper router')
  const viewOf = (agent: AgentLike | undefined): SessionRouteView => routeViewFor(sessionsOf(), registryOf(), agent)

  // P0-1 — routing identity (or an explicit degraded warning) in the runtime
  // context, plus the routing guide. Local sessions render empty and both
  // blocks are omitted. Provider-world detection is lazy too: the capability
  // rows may mount after this plugin's apply.
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt !== undefined) {
    const disposeIdentity = systemPrompt.context({
      name: ROUTE_CONTEXT_NAME,
      order: ROUTE_CONTEXT_ORDER,
      text: (context) => routeContextText(viewOf(context.agent)),
    })
    disposers.push(disposeIdentity)

    // Usage guide — only on live routes: how to run remote commands, what is
    // remote vs local here, and how to recover when a route breaks. This is
    // the "how to use the plugin without hitting walls" brief.
    const disposeUsage = systemPrompt.context({
      name: USAGE_CONTEXT_NAME,
      order: USAGE_CONTEXT_ORDER,
      text: (context) => {
        const view = viewOf(context.agent)
        return view.kind === 'route' ? usageContextText(view.facts, remoteWorldOf(ctx)) : ''
      },
    })
    disposers.push(disposeUsage)
  }

  // P1-5 — trusted DSH_SSH_* variables for routed shell executions.
  const shellEnv = ctx.get('shellEnv') as ShellEnvLike | undefined
  if (shellEnv !== undefined) {
    const keys = {
      DSH_SSH_ROUTE_ID: { description: 'registry connection id of the session\'s SSH route' },
      DSH_SSH_HOST: { description: 'hostname or address of the session\'s SSH target' },
      DSH_SSH_PORT: { description: 'SSH port of the session\'s SSH target' },
      DSH_SSH_USER: { description: 'remote login user of the session\'s SSH route' },
      DSH_SSH_ENDPOINT: { description: '`user@host` spelling of the session\'s SSH route' },
      DSH_SSH_REMOTE_CWD: { description: 'absolute remote working directory of the session\'s SSH route' },
    }
    const dispose = shellEnv.register({
      name: 'ssh-route',
      variables: keys,
      resolve: (execution) => {
        const view = viewOf(execution.agent)
        return view.kind === 'route' ? routeEnvironment(view.facts) : {}
      },
    })
    disposers.push(dispose)
  }

  // P0-2 + P1-4 — the ssh_exec and ssh_route_status tools.
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools !== undefined) {
    const disposeExec = tools.register({
      name: SSH_EXEC_TOOL,
      description:
        'Run one command on the SSH host of the CURRENT session\'s route (the route shown in the runtime '
        + 'context as `ssh://<id>` / "SSH route <id>"), in that route\'s remote working directory. '
        + 'Executes over the plugin\'s in-process SSH channel (no local ssh.exe, no sandbox conflict), '
        + 'locale fixed to C, non-interactive, output capped with truncation marked. '
        + 'Use ONLY when the runtime context shows this session is on an SSH route; on a local session the tool refuses, '
        + 'and on a degraded (spelled-but-unresolvable) route it says so and lists recovery steps. '
        + 'When a route fails, call ssh_route_status first. '
        + 'Inputs: command (required, shell syntax as the remote bash would run it), optional cwd (absolute POSIX path '
        + 'override), optional timeoutMs (1 000–600 000, default 120 000).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run on the remote host (bash syntax).' },
          cwd: {
            type: 'string',
            description: 'Optional absolute POSIX working directory on the remote host; defaults to the session route path.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Optional hard timeout in milliseconds (1 000–600 000; default 120 000).',
          },
        },
        required: ['command'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args, exec) => await executeSshExec(sessionsOf(), registryOf(), router, args as SshExecArgs, exec),
    })
    disposers.push(disposeExec)

    const disposeStatus = tools.register({
      name: SSH_ROUTE_STATUS_TOOL,
      description:
        'Report this session\'s SSH routing situation without touching the network (unless checkLive is true): '
        + 'which route (if any) the session cwd is on, the route\'s target host, every known connection id, '
        + 'and where the human-readable route manifest file lives. When a route is degraded (spelled but not '
        + 'resolvable) or ssh_exec fails, call this first for recovery facts.',
      parameters: {
        type: 'object',
        properties: {
          checkLive: {
            type: 'boolean',
            description: 'When true, dial the connection and run `true` to prove reachability now (touches the network).',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args, exec) => await executeRouteStatus(sessionsOf(), registryOf(), args as RouteStatusArgs, exec),
    })
    disposers.push(disposeStatus)
  }
}
