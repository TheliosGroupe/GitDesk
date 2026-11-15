// Small helpers shared by the terminal, worktree and agent views.

/** Windows paths are case-insensitive. */
export const samePath = (a: string, b: string): boolean =>
  window.api.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Last folder name of a path. */
export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
