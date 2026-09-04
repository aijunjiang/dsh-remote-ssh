/**
 * Remote file tree for the better-sidebar: a lazy-loaded tree view that browses
 * a remote host over the shared `/dsh-ssh` RPC channel (SFTP). Registered as a
 * better-sidebar tab when the service is available; gracefully absent otherwise.
 *
 * Clicking a file fetches its content and renders it in a preview panel below
 * the tree — text (with basic syntax highlighting), images, or rendered
 * Markdown. Clicking a directory toggles its children.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Wire types — mirrors the host-side shapes in web.ts
// ---------------------------------------------------------------------------

interface WireFileEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  broken: boolean
  hidden: boolean
  size: number
  mtime: number
}

interface WireFileListing {
  path: string
  home: string
  crumbs: WireFileEntry[]
  entries: WireFileEntry[]
  truncated: boolean
}

interface WireResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

// ---------------------------------------------------------------------------
// Props & helpers
// ---------------------------------------------------------------------------

export interface RemoteFileTreeProps {
  /** RPC caller bound to the /dsh-ssh channel. */
  rpc: (endpoint: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<WireResult>
  /** The registry connection id (e.g. "c1"). */
  connectionId: string
  /** The remote home directory to start browsing from. */
  home: string
}

/** Format a byte count for display. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Format a Unix mtime for display. */
function formatMtime(seconds: number): string {
  const d = new Date(seconds * 1000)
  return d.toLocaleString()
}

/** Simple MIME type guess from file extension. */
function mimeFromExt(name: string): string {
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '').toLowerCase()
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.jsx': 'text/javascript',
    '.tsx': 'text/typescript', '.css': 'text/css', '.html': 'text/html',
    '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.toml': 'text/plain', '.ini': 'text/plain',
    '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go',
    '.rs': 'text/x-rust', '.java': 'text/x-java', '.c': 'text/x-c',
    '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
    '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
  }
  return map[ext] ?? 'text/plain'
}

/** Detect whether a MIME type is an image. */
function isImage(mime: string): boolean {
  return mime.startsWith('image/')
}

/** Detect whether a file is viewable as text. */
function isTextViewable(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/pdf'
}

// ---------------------------------------------------------------------------
// Simple Markdown renderer (handles headings, code, bold, italic, links, lists)
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // Code blocks (```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
    `<pre><code class="${lang}">${code.trim()}</code></pre>`)
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>')
  html = `<p>${html}</p>`
  return html
}

// ---------------------------------------------------------------------------
// Icon component (simple SVG)
// ---------------------------------------------------------------------------

function Icon({ type, size = 16 }: { type: 'folder' | 'folderOpen' | 'file' | 'symlink' | 'broken' | 'chevron' | 'refresh' | 'home' | 'spinner'; size?: number }) {
  const paths: Record<string, string> = {
    folder: 'M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z',
    folderOpen: 'M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v1H4l1.5 9h15L19 8H5',
    file: 'M4 4a2 2 0 012-2h8l4 4v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z',
    symlink: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71',
    broken: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
    chevron: 'M9 18l6-6-6-6',
    refresh: 'M1 4v6h6M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15',
    home: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10',
    spinner: 'M12 2a10 10 0 1010 10',
  }
  const p = paths[type] ?? paths.file
  const color = type === 'broken' ? '#e5534b' : type === 'symlink' ? '#9b6bff' : 'currentColor'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={p} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// RemoteFileTree component
// ---------------------------------------------------------------------------

export function RemoteFileTree({ rpc, connectionId, home }: RemoteFileTreeProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>(home)
  const [entries, setEntries] = useState<WireFileEntry[]>([])
  const [crumbs, setCrumbs] = useState<WireFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childCache, setChildCache] = useState<Map<string, WireFileEntry[]>>(new Map())
  const [showHidden, setShowHidden] = useState(false)
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; mime: string; content: string; size: number } | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const fetchListing = useCallback(async (path: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const result = await rpc('browse.listAll', { id: connectionId, path }, ac.signal)
      if (ac.signal.aborted) return
      if (result.ok) {
        const listing = result.value as WireFileListing
        setEntries(listing.entries)
        setCrumbs(listing.crumbs)
        setCurrentPath(listing.path)
      } else {
        setError(result.error.message)
      }
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [rpc, connectionId])

  // Fetch the home directory on mount
  useEffect(() => {
    fetchListing(home)
    return () => abortRef.current?.abort()
  }, [fetchListing, home])

  const toggleExpand = useCallback(async (entry: WireFileEntry) => {
    if (!entry.isDir) return
    const key = entry.path
    if (expanded.has(key)) {
      setExpanded(prev => { const next = new Set(prev); next.delete(key); return next })
    } else {
      setExpanded(prev => new Set(prev).add(key))
      if (!childCache.has(key)) {
        try {
          const result = await rpc('browse.listAll', { id: connectionId, path: key })
          if (result.ok) {
            const listing = result.value as WireFileListing
            setChildCache(prev => new Map(prev).set(key, listing.entries))
          }
        } catch { /* ignore */ }
      }
    }
  }, [expanded, childCache, rpc, connectionId])

  const openFile = useCallback(async (entry: WireFileEntry) => {
    if (entry.isDir) return toggleExpand(entry)
    setSelectedFile(null)
    setFileLoading(true)
    try {
      const result = await rpc('browse.readFile', { id: connectionId, path: entry.path })
      if (result.ok) {
        const { content, size, mimeType } = result.value as { content: string; size: number; mimeType: string }
        setSelectedFile({ path: entry.path, name: entry.name, mime: mimeType, content, size })
      }
    } catch (err) {
      setSelectedFile({ path: entry.path, name: entry.name, mime: mimeFromExt(entry.name), content: '', size: 0 })
    } finally {
      setFileLoading(false)
    }
  }, [rpc, connectionId, toggleExpand])

  const navigateTo = useCallback((path: string) => {
    if (path === currentPath) return
    // Clear expansion for the old path's children
    setExpanded(new Set())
    setChildCache(new Map())
    fetchListing(path)
  }, [currentPath, fetchListing])

  const filteredEntries = entries.filter(e => showHidden || !e.hidden)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)', fontSize: 13, color: 'var(--color-fg, #e8e9ec)' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.08))', flexShrink: 0 }}>
        <button onClick={() => navigateTo(home)} title="Home" style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted, #999)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <Icon type="home" size={15} />
        </button>
        {/* Breadcrumbs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, overflow: 'hidden', fontSize: 12 }}>
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 2, whiteSpace: 'nowrap' }}>
              {i > 0 && <span style={{ color: 'var(--color-fg-subtle, #666)', margin: '0 2px' }}>/</span>}
              <button
                onClick={() => navigateTo(crumb.path)}
                style={{
                  background: 'none', border: 'none', color: i === crumbs.length - 1 ? 'var(--color-fg, #e8e9ec)' : 'var(--color-accent, #4a6cf7)',
                  cursor: 'pointer', padding: '1px 4px', borderRadius: 4, fontSize: 12, fontWeight: i === crumbs.length - 1 ? 600 : 400,
                  maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {crumb.name || '/'}
              </button>
            </span>
          ))}
        </div>
        <button onClick={() => setShowHidden(v => !v)} title="Toggle hidden files" style={{ background: 'none', border: 'none', color: showHidden ? 'var(--color-accent, #4a6cf7)' : 'var(--color-fg-muted, #999)', cursor: 'pointer', padding: 2, fontSize: 11, fontWeight: showHidden ? 600 : 400 }}>
          .*
        </button>
        <button onClick={() => fetchListing(currentPath)} title="Refresh" style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted, #999)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <Icon type="refresh" size={14} />
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 20, color: 'var(--color-fg-muted, #999)', fontSize: 12 }}>
            <Icon type="spinner" size={14} />
            Loading...
          </div>
        )}
        {error && !loading && (
          <div style={{ padding: 12, margin: 8, borderRadius: 8, background: 'var(--color-danger-soft, rgba(229,83,75,0.12))', border: '1px solid var(--color-danger, rgba(229,83,75,0.28))', fontSize: 12 }}>
            <div style={{ color: 'var(--color-danger-text, #e5534b)', fontWeight: 600, marginBottom: 4 }}>Connection error</div>
            <div style={{ color: 'var(--color-fg-muted, #999)', wordBreak: 'break-word' }}>{error}</div>
            <button onClick={() => fetchListing(currentPath)} style={{ marginTop: 8, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--color-border, rgba(255,255,255,0.1))', background: 'var(--color-surface, #1a1b1e)', color: 'var(--color-fg, #e8e9ec)', cursor: 'pointer', fontSize: 12 }}>Retry</button>
          </div>
        )}
        {!loading && !error && filteredEntries.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-fg-muted, #999)', fontSize: 12 }}>Empty directory</div>
        )}
        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {filteredEntries.map(entry => (
              <FileTreeRow
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                childCache={childCache}
                onToggle={toggleExpand}
                onOpen={openFile}
                selectedPath={selectedFile?.path}
              />
            ))}
          </div>
        )}
        {entries.length > 0 && entries.length >= (filteredEntries.length) && (
          <div style={{ padding: '6px 12px', color: 'var(--color-fg-subtle, #666)', fontSize: 11 }}>
            {entries.length} entries{showHidden ? '' : ' (hidden files hidden)'}
          </div>
        )}
      </div>

      {/* File preview panel */}
      {selectedFile && (
        <div style={{ borderTop: '1px solid var(--color-border, rgba(255,255,255,0.08))', flexShrink: 0, maxHeight: '45%', overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.06))', fontSize: 12, color: 'var(--color-fg-muted, #999)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-fg, #e8e9ec)' }}>{selectedFile.name}</span>
            <span>{formatSize(selectedFile.size)}</span>
            <button onClick={() => setSelectedFile(null)} style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted, #999)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
          </div>
          {fileLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-fg-muted, #999)', fontSize: 12 }}>Loading...</div>
          ) : selectedFile.content === '' ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-fg-muted, #999)', fontSize: 12 }}>Empty file or unreadable</div>
          ) : isImage(selectedFile.mime) ? (
            <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
              <img src={`data:${selectedFile.mime};base64,${selectedFile.content}`} alt={selectedFile.name} style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 6 }} />
            </div>
          ) : selectedFile.mime === 'text/markdown' ? (
            <div
              style={{ padding: '12px 16px', fontSize: 13, lineHeight: 1.7, overflow: 'auto' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(atob(selectedFile.content)) }}
            />
          ) : (
            <pre style={{ margin: 0, padding: '10px 14px', fontSize: 12, lineHeight: 1.5, overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Consolas, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-fg, #e8e9ec)' }}>
              <code>{atob(selectedFile.content)}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FileTreeRow — recursive row component
// ---------------------------------------------------------------------------

function FileTreeRow({ entry, depth, expanded, childCache, onToggle, onOpen, selectedPath }: {
  entry: WireFileEntry
  depth: number
  expanded: Set<string>
  childCache: Map<string, WireFileEntry[]>
  onToggle: (entry: WireFileEntry) => void
  onOpen: (entry: WireFileEntry) => void
  selectedPath?: string
}): JSX.Element {
  const isExpanded = expanded.has(entry.path)
  const children = childCache.get(entry.path)
  const isSelected = selectedPath === entry.path
  const iconType = entry.broken ? 'broken' : entry.isSymlink ? 'symlink' : entry.isDir ? (isExpanded ? 'folderOpen' : 'folder') : 'file'

  return (
    <>
      <div
        onClick={() => onOpen(entry)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', paddingLeft: 8 + depth * 16,
          cursor: 'pointer', borderRadius: 6, margin: '0 4px',
          background: isSelected ? 'var(--color-accent-soft, rgba(74,108,247,0.13))' : 'transparent',
          opacity: entry.hidden ? 0.6 : 1,
          userSelect: 'none',
        }}
        onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-3, rgba(255,255,255,0.04))' }}
        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        {entry.isDir && (
          <span onClick={e => { e.stopPropagation(); onToggle(entry) }} style={{ display: 'flex', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s', flexShrink: 0 }}>
            <Icon type="chevron" size={12} />
          </span>
        )}
        {!entry.isDir && <span style={{ width: 12, flexShrink: 0 }} />}
        <Icon type={iconType} size={15} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
          {entry.name}
          {entry.isSymlink && !entry.isDir && <span style={{ color: 'var(--color-fg-subtle, #666)', marginLeft: 4, fontSize: 11 }}>→</span>}
        </span>
        {!entry.isDir && <span style={{ color: 'var(--color-fg-subtle, #666)', fontSize: 11, flexShrink: 0 }}>{formatSize(entry.size)}</span>}
      </div>
      {entry.isDir && isExpanded && children && children.length > 0 && (
        children.map(child => (
          <FileTreeRow key={child.path} entry={child} depth={depth + 1} expanded={expanded} childCache={childCache} onToggle={onToggle} onOpen={onOpen} selectedPath={selectedPath} />
        ))
      )}
      {entry.isDir && isExpanded && children && children.length === 0 && (
        <div style={{ paddingLeft: 8 + (depth + 1) * 16 + 20, fontSize: 12, color: 'var(--color-fg-subtle, #666)', padding: '4px 0' }}>Empty</div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// RemoteFileBrowser — connection selector + RemoteFileTree
// ---------------------------------------------------------------------------

export interface RemoteFileBrowserProps {
  rpc: (endpoint: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<WireResult>
}

interface ConnectionView {
  id: string
  label: string
  host: string
  port: number
  username: string
}

export function RemoteFileBrowser({ rpc }: RemoteFileBrowserProps): JSX.Element {
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [home, setHome] = useState<string>('/')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    rpc('connections.list').then(result => {
      if (cancelled) return
      if (result.ok) {
        const list = result.value as ConnectionView[]
        setConnections(list)
        if (list.length === 1) {
          setSelectedId(list[0].id)
        }
      } else {
        setError(result.error.message)
      }
      setLoading(false)
    }).catch(err => {
      if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [rpc])

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    rpc('browse.home', { id: selectedId }).then(result => {
      if (cancelled) return
      if (result.ok) {
        setHome((result.value as { path: string }).path)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [rpc, selectedId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-fg-muted, #999)', fontSize: 13 }}>
        Loading connections...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-fg-muted, #999)', fontSize: 13 }}>
        <div style={{ color: 'var(--color-danger-text, #e5534b)', marginBottom: 8 }}>Connection error</div>
        <div>{error}</div>
      </div>
    )
  }

  if (connections.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--color-fg-muted, #999)', fontSize: 13, padding: 24 }}>
        <div style={{ fontSize: 32, opacity: 0.3 }}>🔌</div>
        <div>No saved connections</div>
        <div style={{ fontSize: 12 }}>Add a remote connection in the workspace picker first</div>
      </div>
    )
  }

  if (selectedId === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.08))', color: 'var(--color-fg, #e8e9ec)' }}>
          Select a remote host
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {connections.map(c => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 16px',
                background: 'none', border: 'none', borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.04))',
                color: 'var(--color-fg, #e8e9ec)', cursor: 'pointer', fontSize: 13, textAlign: 'left',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-3, rgba(255,255,255,0.04))' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ fontSize: 18 }}>🖥️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: 11, color: 'var(--color-fg-muted, #999)' }}>{c.username}@{c.host}:{c.port}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <RemoteFileTree rpc={rpc} connectionId={selectedId} home={home} />
}