// .gitignore patterns that match one file name literally.

/**
 * Escapes the characters .gitignore would read as a pattern: `\ * ? [ ]`, a leading
 * `#` (comment) or `!` (negation), and trailing spaces (which git otherwise drops).
 */
export function escapeIgnore(text: string): string {
  const escaped = text.replace(/[\\*?[\]]/g, '\\$&').replace(/^[#!]/, '\\$&')
  return escaped.replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length))
}

/** Pattern ignoring exactly this file (path relative to the repository, with `/`). */
export function ignoreFilePattern(path: string): string {
  return `/${escapeIgnore(path)}`
}

/** Pattern ignoring every file with this extension. */
export function ignoreExtensionPattern(ext: string): string {
  return `*.${escapeIgnore(ext)}`
}
