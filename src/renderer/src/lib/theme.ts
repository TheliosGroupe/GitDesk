// Applies the color theme as <html data-theme="dark|light">; main.css switches every color on it.
import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_PALETTES,
  LANE_COUNT,
  type BranchColors,
  type PaletteTheme
} from '../../../shared/branchColors'
import type { Theme } from '../../../shared/types'

/** Last chosen theme, so the next launch paints in the right colors before settings load. */
const CACHE_KEY = 'gitdesk.theme'

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(theme: Theme): 'dark' | 'light' {
  return theme === 'system' ? (darkQuery().matches ? 'dark' : 'light') : theme
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme)
}

/** Called once before the first render: uses the cached choice (dark when unknown). */
export function applyCachedTheme(): void {
  let theme: Theme = 'dark'
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached === 'dark' || cached === 'light' || cached === 'system') theme = cached
  } catch {
    // Storage unavailable: keep dark.
  }
  apply(theme)
}

/** Keeps the document theme in sync with the setting, following the OS when it is 'system'. */
export function useTheme(theme: Theme | undefined): void {
  useEffect(() => {
    if (!theme) return
    apply(theme)
    try {
      localStorage.setItem(CACHE_KEY, theme)
    } catch {
      // Not critical: only avoids a flash on the next launch.
    }
    if (theme !== 'system') return
    const query = darkQuery()
    const onChange = (): void => apply(theme)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])
}

const subscribeTheme = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}
const currentTheme = (): PaletteTheme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'

/** The theme on screen ('system' resolved), re-rendering when it changes. */
export function useResolvedTheme(): PaletteTheme {
  return useSyncExternalStore(subscribeTheme, currentTheme)
}

/**
 * Applies the custom lane palette of the theme on screen as `--lane-0…7` on <html>
 * (main.css keeps the defaults when there is none).
 */
export function useLanePalette(colors: BranchColors | undefined): void {
  const theme = useResolvedTheme()
  const custom = colors?.[theme]
  const key = custom?.length === LANE_COUNT ? custom.join(',') : ''
  useEffect(() => {
    const style = document.documentElement.style
    const palette = key ? key.split(',') : null
    for (let i = 0; i < DEFAULT_PALETTES[theme].length; i++) {
      if (palette) style.setProperty(`--lane-${i}`, palette[i])
      else style.removeProperty(`--lane-${i}`)
    }
  }, [theme, key])
}
