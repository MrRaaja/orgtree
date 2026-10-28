// Canvas view options: per-project colour and icon, and collapsible teams.
// Display-only, like hide-retired: the LAYOUT tree is pruned, `map` stays
// full, and every choice lives in this machine's localStorage per org. No
// engine or main-process change. The canvas provides ViewOptionsContext; without
// a provider (tests, other surfaces) every piece here renders nothing.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DRAFT } from './shared'
import type { CanvasNode } from './shared'
import type { MenuEntry } from './contextmenu'

/* ------------------------------------------------------------ stores */

type Listener = () => void
const subs = new Map<string, Set<Listener>>()
const cache = new Map<string, { raw: string | null; value: unknown }>()

function readJson<T>(key: string, fallback: T): T {
  let raw: string | null = null
  try { raw = localStorage.getItem(key) } catch { /* private mode */ }
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.value as T
  let value: T = fallback
  try { if (raw) value = JSON.parse(raw) as T } catch { /* corrupt: fallback */ }
  cache.set(key, { raw, value })
  return value
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
  for (const fn of [...(subs.get(key) ?? [])]) fn()
}
function useJson<T>(key: string, fallback: T): T {
  const subscribe = useMemo(() => (fn: Listener) => {
    if (!subs.has(key)) subs.set(key, new Set())
    subs.get(key)!.add(fn)
    window.addEventListener('storage', fn)
    return () => { subs.get(key)?.delete(fn); window.removeEventListener('storage', fn) }
  }, [key])
  return useSyncExternalStore(subscribe, () => readJson(key, fallback))
}

const NO_IDS: string[] = []
const NO_LOOKS: Record<string, ProjectLook> = {}
const collapsedKey = (slug: string) => `orgtree-collapsed-${slug}`
const lookKey = (slug: string) => `orgtree-project-look-${slug}`
export const AUTO_LOOK_KEY = 'orgtree-project-autolook'

export const useCollapsedIds = (slug: string): string[] => useJson(collapsedKey(slug), NO_IDS)
export const setCollapsedIds = (slug: string, ids: Iterable<string>) => writeJson(collapsedKey(slug), [...new Set(ids)])
export const useProjectLooks = (slug: string) => useJson(lookKey(slug), NO_LOOKS)
export const setProjectLook = (slug: string, id: string, look: ProjectLook | null) => {
  const next = { ...readJson(lookKey(slug), NO_LOOKS) }
  if (look && (look.color || look.icon)) next[id] = look
  else delete next[id]
  writeJson(lookKey(slug), next)
}
/** Automatic colour and icon for projects without a chosen one. ON unless turned off. */
export const useAutoProjectLook = (): boolean => useJson<string>(AUTO_LOOK_KEY, '1') !== '0'
export const setAutoProjectLook = (on: boolean) => writeJson(AUTO_LOOK_KEY, on ? '1' : '0')

/* ------------------------------------------------------------ collapse */

/** Removes the descendants of every collapsed node from the LAYOUT tree (pure).
 *  A collapsed node keeps its card; the draft card always stays, so hiring
 *  under a collapsed team still shows the form. Returns the pruned root, the
 *  hidden-node count per collapsed node (non-retired agents and projects) and
 *  every pruned id (centerOn's reveal hook). */
export function pruneCollapsedView(root: CanvasNode, collapsed: ReadonlySet<string>): {
  root: CanvasNode
  hiddenCount: Map<string, number>
  prunedIds: Set<string>
} {
  const hiddenCount = new Map<string, number>()
  const prunedIds = new Set<string>()
  if (!collapsed.size) return { root, hiddenCount, prunedIds }
  const bury = (n: CanvasNode): number => {
    prunedIds.add(n.id)
    let count = n.state === 'archived' ? 0 : 1
    for (const c of n.children ?? []) count += bury(c)
    return count
  }
  const walk = (n: CanvasNode): CanvasNode => {
    const kids = n.children ?? []
    if (collapsed.has(n.id) && kids.some((c) => c.id !== DRAFT)) {
      let count = 0
      for (const c of kids) if (c.id !== DRAFT) count += bury(c)
      hiddenCount.set(n.id, count)
      return { ...n, children: kids.filter((c) => c.id === DRAFT) }
    }
    const next = kids.map(walk)
    return next.some((c, i) => c !== kids[i]) ? { ...n, children: next } : n
  }
  return { root: walk(root), hiddenCount, prunedIds }
}

/* ------------------------------------------------------------ project look */

export type ProjectLook = { color?: string; icon?: string }

/** Distinct hues that read on dark, light, solarized and obsidian panels. */
export const PROJECT_PALETTE = ['#539bf5', '#e0823d', '#57ab5a', '#d65db1', '#c9a227', '#39c5cf',
  '#8a6fdf', '#e5534b', '#2aa198', '#a0785a']

const hash = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h }

/** Auto colours for every project in the org: each starts at its name's hash
 *  and takes the next free hue, in name order, so siblings differ and a
 *  project keeps its colour while the set of projects is unchanged. */
export function autoProjectColors(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<number>()
  for (const id of [...ids].sort()) {
    let i = hash(id.toLowerCase()) % PROJECT_PALETTE.length
    for (let n = 0; n < PROJECT_PALETTE.length && used.has(i); n++) i = (i + 1) % PROJECT_PALETTE.length
    used.add(i)
    out.set(id, PROJECT_PALETTE[i]!)
  }
  return out
}

/** An icon suggested by the project's name, for the automatic look. */
export function suggestedIcon(id: string): string | undefined {
  const n = id.toLowerCase()
  if (/vision|camera|video|image/.test(n)) return 'camera'
  if (/robot|\bbot\b|drone/.test(n)) return 'robot'
  if (/\bcad\b|design|3d|mechanic/.test(n)) return 'cube'
  if (/financ|money|budget|metric|analytic/.test(n)) return 'chart'
  if (/social|marketing|content/.test(n)) return 'megaphone'
  if (/research|lab|experiment/.test(n)) return 'flask'
  if (/docs?\b|wiki|writing/.test(n)) return 'book'
  if (/launch|release|deploy/.test(n)) return 'rocket'
  return undefined
}

/* Stroke icons on a 24-unit grid, drawn for the canvas; currentColor strokes
 * take the project's colour. */
export const ICONS: Record<string, { label: string; d: string }> = {
  'camera': { label: 'Camera', d:'M3 8h3l1.5-2h5L14 8h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM10 15.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 11l4-2v7l-4-2M2 21c5-3 15-3 20 0' },
  'launcher': { label: 'Launcher', d:'M6 19a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 15.5h7M6 12c1.2 2 1.2 5 0 7M8.5 12.5C11 6 16 3.5 21 4M17 3.5l4 .5-1.5 3.5M21 9v3M18.5 10.5h5' },
  'robot': { label: 'Robot', d:'M7 8h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 8V5M10.5 4h3M9.5 12.5h.01M14.5 12.5h.01M9.5 15.5h5M5 12H3M21 12h-2M7 18v2.5M17 18v2.5' },
  'cube': { label: 'CAD part', d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5' },
  'chart': { label: 'Chart', d: 'M4 20h16M7 16v-5M12 16V6M17 16v-8' },
  'glass': { label: 'Glass', d: 'M5 4h14l-7 8zM12 12v7M8 20h8' },
  'megaphone': { label: 'Megaphone', d: 'M3 10v4h3l7 4V6L6 10zM16 9a4 4 0 0 1 0 6M6 14l1 5h2.5' },
  'code': { label: 'Code', d: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16' },
  'gear': { label: 'Gear', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
  'rocket': { label: 'Rocket', d: 'M12 2c3 2.5 4.5 6 4.5 10L14 16h-4l-2.5-4C7.5 8 9 4.5 12 2zM12 9.5h.01M10 16l-1.5 4.5M14 16l1.5 4.5M7.5 12 4 14l1 3M16.5 12 20 14l-1 3' },
  'flask': { label: 'Flask', d: 'M9 3h6M10 3v6L4.5 19a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L14 9V3M7 15h10' },
  'bolt': { label: 'Bolt', d: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  'star': { label: 'Star', d: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z' },
  'book': { label: 'Book', d: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z' },
  'folder': { label: 'Folder', d: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' },
}

/** A chosen icon: a built-in name, or an image data URL the user uploaded. */
export function LookIcon({ icon }: { icon: string }) {
  if (icon.startsWith('data:image/')) return <img className="vo-icon-img" src={icon} alt="" draggable={false} />
  const def = ICONS[icon]
  if (!def) return null
  return <svg className="vo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={def.d} /></svg>
}

/* ------------------------------------------------------------ context */

export type ViewOptions = {
  /** hidden descendants of a collapsed node; undefined while expanded */
  collapsedCount: (id: string) => number | undefined
  /** the node has reports or nested projects in the full tree */
  hasTeam: (id: string) => boolean
  toggle: (id: string) => void
  /** expand this node and every collapsed node under it */
  expandAll: (id: string) => void
  /** collapse every team under this node, keeping the node itself open */
  collapseBelow: (id: string) => void
  /** the resolved look of a project (chosen, else automatic) */
  look: (id: string) => ProjectLook | undefined
  /** the colour of the nearest enclosing project, for an agent's stripe */
  projectColor: (id: string) => string | undefined
  editLook: (id: string) => void
}
export const ViewOptionsContext = createContext<ViewOptions | null>(null)
export const useViewOptions = () => useContext(ViewOptionsContext)

/** The canvas side: everything the context needs, from the full node map. */
export function useViewOptionsState(slug: string, map: ReadonlyMap<string, CanvasNode>,
  hiddenCount: ReadonlyMap<string, number>) {
  const collapsedIds = useCollapsedIds(slug)
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds])
  const looks = useProjectLooks(slug)
  const auto = useAutoProjectLook()
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => { setEditing(null) }, [slug])
  const projects = useMemo(() => [...map.values()].filter((n) => n.kind === 'project').map((n) => n.id), [map])
  const autoColors = useMemo(() => autoProjectColors(projects), [projects])
  const mod = useMemo<ViewOptions>(() => {
    const look = (id: string): ProjectLook | undefined => {
      const chosen = looks[id]
      const color = chosen?.color ?? (auto ? autoColors.get(id) : undefined)
      const icon = chosen?.icon ?? (auto ? suggestedIcon(id) : undefined)
      return color || icon ? { color, icon } : undefined
    }
    const under = (id: string): CanvasNode[] => {
      const out: CanvasNode[] = []
      const walk = (n: CanvasNode) => { for (const c of n.children ?? []) { out.push(c); walk(c) } }
      const n = map.get(id)
      if (n) walk(n)
      return out
    }
    return {
      collapsedCount: (id) => collapsed.has(id) ? hiddenCount.get(id) : undefined,
      hasTeam: (id) => (map.get(id)?.children ?? []).some((c) => c.id !== DRAFT),
      toggle: (id) => {
        const next = new Set(collapsed)
        if (next.has(id)) next.delete(id); else next.add(id)
        setCollapsedIds(slug, next)
      },
      expandAll: (id) => {
        const drop = new Set([id, ...under(id).map((n) => n.id)])
        setCollapsedIds(slug, [...collapsed].filter((c) => !drop.has(c)))
      },
      collapseBelow: (id) => {
        const teams = under(id).filter((n) => (n.children ?? []).some((c) => c.id !== DRAFT)).map((n) => n.id)
        setCollapsedIds(slug, [...[...collapsed].filter((c) => c !== id), ...teams])
      },
      look,
      projectColor: (id) => {
        let cur = map.get(id)?.parent ?? undefined
        while (cur) {
          const n = map.get(cur)
          if (!n) return undefined
          if (n.kind === 'project') return look(n.id)?.color
          cur = n.parent ?? undefined
        }
        return undefined
      },
      editLook: setEditing,
    }
  }, [slug, map, collapsed, hiddenCount, looks, auto, autoColors])
  return { collapsed, mod, editing, closeEditor: () => setEditing(null) }
}

/** Collapse every team below the top-level agents: each top-level agent
 *  (directly under the user or a project) keeps its card, its team folds. */
export function collapseToTopLevel(slug: string, roots: CanvasNode[]) {
  const out: string[] = []
  const walk = (n: CanvasNode, underAgent: boolean) => {
    const isAgent = n.kind !== 'project' && n.state !== 'user'
    if (isAgent && !underAgent && (n.children ?? []).some((c) => c.id !== DRAFT)) out.push(n.id)
    for (const c of n.children ?? []) walk(c, underAgent || isAgent)
  }
  roots.forEach((r) => walk(r, false))
  setCollapsedIds(slug, out)
}

/* ------------------------------------------------------------ card pieces */

/** The header chip: "+N" while collapsed (click expands); a quiet fold
 *  arrow on hover while expanded (click collapses). Last-but-retired. */
export function CollapseChip({ id }: { id: string }) {
  const mod = useViewOptions()
  if (!mod || !mod.hasTeam(id)) return null
  const count = mod.collapsedCount(id)
  const closed = count !== undefined
  return <button type="button" className={'badge vo-collapse' + (closed ? ' closed' : ' open')}
    data-collapse-node={id}
    title={closed ? `${count} hidden below — click to expand` : 'Collapse this team'}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => { e.stopPropagation(); mod.toggle(id) }}>{closed ? `▸ ${count}` : '▾'}</button>
}

/** An agent card's thin stripe in its project's colour. */
export function ProjectStripe({ id }: { id: string }) {
  const mod = useViewOptions()
  const color = mod?.projectColor(id)
  return color ? <span className="vo-stripe" style={{ background: color }} aria-hidden="true" /> : null
}

/** The mod's entries for an agent or project context menu. */
export function viewOptionEntries(mod: ViewOptions | null, node: CanvasNode): MenuEntry[] {
  if (!mod) return []
  const out: MenuEntry[] = []
  if (mod.hasTeam(node.id)) {
    const closed = mod.collapsedCount(node.id) !== undefined
    out.push({ label: closed ? 'Expand team' : 'Collapse team', onSelect: () => mod.toggle(node.id) })
    out.push({ label: 'Collapse all teams below', title: 'keep this card open, fold every team under it',
      onSelect: () => mod.collapseBelow(node.id) })
    out.push({ label: 'Expand everything below', onSelect: () => mod.expandAll(node.id) })
  }
  if (node.kind === 'project') out.push({ label: 'Color & icon…', onSelect: () => mod.editLook(node.id) })
  return out
}

/* ------------------------------------------------------------ dialog */

/** Shrinks an uploaded image to a 64 px square PNG data URL (kept in localStorage). */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const size = 64, c = document.createElement('canvas')
      c.width = c.height = size
      const ctx = c.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('no canvas')); return }
      const s = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')) }
    img.src = url
  })
}

export function ProjectLookDialog({ slug, id, current, onClose }: {
  slug: string; id: string; current: ProjectLook | undefined; onClose: () => void
}) {
  const chosen = useProjectLooks(slug)[id]
  const shown = { ...current, ...chosen }
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [onClose])
  const set = (patch: ProjectLook) => setProjectLook(slug, id, { ...chosen, ...patch })
  return <div className="vo-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="vo-dialog" role="dialog" aria-modal="true" aria-label={`Color and icon for ${id}`}
      style={{ '--vo-color': shown.color ?? 'var(--accent)' } as React.CSSProperties}>
      <div className="vo-dialog-head">
        <span className="vo-preview">{shown.icon ? <LookIcon icon={shown.icon} /> : <LookIcon icon="folder" />}</span>
        <strong>{id}</strong>
        <button type="button" className="vo-x" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="vo-label">Color</div>
      <div className="vo-swatches">
        {PROJECT_PALETTE.map((c) => <button key={c} type="button" className={'vo-swatch' + (shown.color === c ? ' on' : '')}
          style={{ background: c }} title={c} onClick={() => set({ color: c })} />)}
        <label className="vo-swatch vo-custom" title="Custom color">
          <input type="color" value={shown.color ?? '#539bf5'} onChange={(e) => set({ color: e.target.value })} />+
        </label>
      </div>
      <div className="vo-label">Icon</div>
      <div className="vo-icons">
        {Object.entries(ICONS).map(([name, def]) => <button key={name} type="button" title={def.label}
          className={'vo-iconbtn' + (shown.icon === name ? ' on' : '')} onClick={() => set({ icon: name })}>
          <LookIcon icon={name} /></button>)}
        <button type="button" className={'vo-iconbtn vo-upload' + (shown.icon?.startsWith('data:') ? ' on' : '')}
          title="Upload an image (any picture, e.g. one made with an AI image tool)"
          onClick={() => fileRef.current?.click()}>
          {shown.icon?.startsWith('data:') ? <LookIcon icon={shown.icon} /> : '⤒'}</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) shrinkImage(f).then((icon) => { setError(''); set({ icon }) }, (err: Error) => setError(err.message))
        }} />
      </div>
      {error && <div className="vo-error">{error}</div>}
      <div className="vo-actions">
        <button type="button" onClick={() => setProjectLook(slug, id, null)}
          title="Back to the automatic color and icon">Reset</button>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </div>
  </div>
}
