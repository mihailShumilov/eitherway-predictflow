import { useEffect, useRef } from 'react'

// Focuses the first focusable element inside `containerRef` when `active`
// becomes true, cycles Tab/Shift-Tab within the container, restores focus
// to the previously-active element when `active` goes false, and calls
// `onEscape` on Escape.
export function useFocusTrap(active, onEscape) {
  const containerRef = useRef(null)
  const previousFocusRef = useRef(null)

  useEffect(() => {
    if (!active) return
    previousFocusRef.current = document.activeElement

    const container = containerRef.current
    if (!container) return

    const focusableSelectors = [
      'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
      'input:not([disabled])', 'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')

    const getFocusable = () => Array.from(container.querySelectorAll(focusableSelectors))
      .filter(el => !el.hasAttribute('aria-hidden') && el.offsetParent !== null)

    // Move focus into the modal on next paint. Using rAF instead of
    // queueMicrotask ensures the modal is actually laid out — otherwise
    // elements that fade in may not be focusable yet.
    const raf = requestAnimationFrame(() => {
      const focusable = getFocusable()
      if (focusable.length) focusable[0].focus()
    })

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onEscape?.()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (!focusable.length) { e.preventDefault(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKey)
      const prev = previousFocusRef.current
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus()
      }
    }
  }, [active, onEscape])

  return containerRef
}
