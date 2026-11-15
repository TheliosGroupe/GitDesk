/** A sentence for a toast about files kept from the AI provider ('' when none). */
export function withheldText(paths: string[]): string {
  if (!paths.length) return ''
  if (paths.length === 1) return `${paths[0]} looks like it holds secrets: only its name was sent.`
  const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? '…' : '')
  return `${paths.length} files look like they hold secrets: only their names were sent (${shown}).`
}
