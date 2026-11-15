// Whether a repository tab shows its terminal panel.

/** 'closed' = never opened in this tab; 'hidden' = opened, then toggled off (shells keep running). */
export type TerminalState = 'closed' | 'open' | 'hidden'

export const toggleTerminal = (s: TerminalState): TerminalState =>
  s === 'open' ? 'hidden' : 'open'
