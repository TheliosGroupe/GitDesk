import { ShieldAlert } from 'lucide-react'
import '../../assets/ai.css'

/** Files whose content was kept from the AI provider because they look like secrets. */
export function WithheldNote({ paths }: { paths: string[] }): React.JSX.Element | null {
  if (!paths.length) return null
  return (
    <div className="ai-withheld" role="note">
      <ShieldAlert size={14} />
      <span>
        {paths.length === 1 ? 'This file looks' : 'These files look'} like{' '}
        {paths.length === 1 ? 'it holds' : 'they hold'} secrets (keys, tokens, credentials), so only{' '}
        {paths.length === 1 ? 'its name was' : 'their names were'} sent:{' '}
        <span className="mono">{paths.slice(0, 20).join(', ')}</span>
        {paths.length > 20 && ` and ${paths.length - 20} more`}.
      </span>
    </div>
  )
}
