/**
 * Shared UI utilities for the dsh-ssh client: a class-name joiner and the
 * dialog behavior every modal reuses — a document-level close stack (Esc
 * always dismisses the topmost dialog only), a Tab focus trap, initial focus,
 * focus restoration, and wheel containment. No external focus-management
 * dependency.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Join truthy class-name fragments; false/null/undefined drop out. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Live dialog closers; only the top entry reacts to Esc and Tab. */
const stack: Array<() => void> = []

/** True when this element can scroll on either axis (overflow, not hidden overflow). */
function scrollsAlong(style: CSSStyleDeclaration, node: Element): boolean {
  const scrollable = /(auto|scroll|overlay)/
  return (scrollable.test(style.overflowY) && node.scrollHeight - node.clientHeight > 1)
    || (scrollable.test(style.overflowX) && node.scrollWidth - node.clientWidth > 1)
}

/**
 * The innermost scroll container a gesture over `target` belongs to, never
 * climbing past `root`. Walks the flat tree, so a shadow boundary inside the
 * host shell cannot hide one.
 */
function scrollRegionUnder(target: Element | null, root: HTMLElement): HTMLElement | null {
  let node: Element | null = target
  while (node !== null && node !== root) {
    if (node instanceof HTMLElement && scrollsAlong(getComputedStyle(node), node)) return node
    const parent: Element | null = node.parentElement
      ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
    node = parent
    if (node !== null && !root.contains(node) && node !== root) return null
  }
  return null
}

/**
 * Contain wheel scrolling inside one dialog.
 *
 * `overscroll-behavior: contain` only stops a region from chaining to its
 * ancestor once that region is at its end — it does nothing for a gesture that
 * lands on something that cannot scroll at all (the header, the footer, an
 * empty pane, a list shorter than its box). Those gestures climb straight out of
 * the dialog and move the workspace sidebar behind it, which is exactly the
 * reported bug: nothing under the cursor moved, the page underneath did.
 *
 * So the gesture is owned here: cancel the native scroll and drive the
 * innermost scrollable region under the cursor directly. If no region can
 * absorb the gesture, nothing moves — the page behind included. Cancelling the
 * wheel event is also what stops macOS inertia (which keeps firing after the
 * finger lifts and would otherwise chain out of the dialog later) from reaching
 * the page.
 */
function containWheel(element: HTMLElement): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey) return // pinch-zoom, not scrolling
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
    let deltaX = event.deltaX * unit
    let deltaY = event.deltaY * unit
    if (event.shiftKey && deltaY !== 0 && deltaX === 0) {
      deltaX = deltaY
      deltaY = 0
    }
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    const region = scrollRegionUnder(event.target as Element | null, element)
    if (region === null) return
    if (region.scrollHeight - region.clientHeight > 1) region.scrollTop += deltaY
    if (region.scrollWidth - region.clientWidth > 1) region.scrollLeft += deltaX
  }

  element.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => {
    element.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
  }
}

/**
 * Wheel containment backstop for a dialog's overlay: whatever the overlay
 * contains is the only thing a wheel gesture may scroll. Two layers, because
 * neither is sufficient alone —
 *
 *  - `overscroll-behavior: contain` on the overlay's scrollable descendants
 *    keeps a region that IS at its end from chaining out;
 *  - a capture-phase wheel handler owns the gesture itself, so a gesture over
 *    a non-scrollable part of the dialog cannot escape the overlay either.
 *
 * Scrollable regions inside a nested dialog stay uncontained (that dialog's
 * own overlay contains them), so stacking two dialogs does not freeze the inner
 * one's lists.
 */
export function useWheelContainment(active: boolean): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!active) return
    const overlay = ref.current
    if (overlay === null) return

    const touched: Array<{ node: HTMLElement; value: string }> = []
    const containScrollable = (): void => {
      // Regions of THIS dialog only: a nested dialog runs its own containment.
      const own = overlay.querySelector(':scope > [data-dshssh-dialog]')
      if (own === null) return
      for (const node of own.querySelectorAll<HTMLElement>('*')) {
        if (!scrollsAlong(getComputedStyle(node), node)) continue
        if (node.style.overscrollBehavior.includes('contain')) continue
        touched.push({ node, value: node.style.overscrollBehavior })
        node.style.overscrollBehavior = 'contain'
      }
    }

    containScrollable()
    // The dialog's regions are populated asynchronously (listings, connection
    // lists), so a region can appear after the first pass.
    const observer = new MutationObserver(() => { containScrollable() })
    observer.observe(overlay, { childList: true, subtree: true })

    const releaseWheel = containWheel(overlay)
    return () => {
      observer.disconnect()
      releaseWheel()
      for (const entry of touched) entry.node.style.overscrollBehavior = entry.value
    }
  }, [active])

  return ref
}

/**
 * Dialog accessibility behavior for one modal while `active`.
 * Returns the ref to place on the dialog element.
 */
export function useDialogA11y(active: boolean, onClose: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!active) return
    const element = ref.current
    if (element === null) return
    const close = (): void => { closeRef.current() }
    stack.push(close)

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = (): HTMLElement[] =>
      Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(node => node.offsetParent !== null)

    element.tabIndex = -1
    const initial = element.querySelector<HTMLElement>('input, textarea, select')
    ;(initial ?? element).focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== close) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusables()
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        element.focus()
        return
      }
      const current = document.activeElement
      const atStart = current === first || current === element || current === document.body || current === null
      const atEnd = current === last || current === element || current === document.body || current === null
      if (event.shiftKey && atStart) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && atEnd) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = stack.lastIndexOf(close)
      if (index >= 0) stack.splice(index, 1)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active])

  return ref
}
