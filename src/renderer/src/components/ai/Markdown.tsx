import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { parseMarkdown, type Block, type Inline, type ListBlock } from './mdParse'

/** Text past this length is shown as plain text, not parsed as Markdown. */
export const MAX_MARKDOWN_CHARS = 200_000

/**
 * `text`, but while it keeps changing (a streamed answer) at most one new value per
 * interval, so the whole answer is not re-parsed on every chunk. The last value always
 * arrives; the interval grows with the text (a parse is linear in it).
 */
function useThrottled(text: string): string {
  const [shown, setShown] = useState(text)
  const last = useRef(0)
  useEffect(() => {
    if (shown === text) return
    const interval = 100 + Math.min(text.length, MAX_MARKDOWN_CHARS) / 2000
    const t = setTimeout(
      () => {
        last.current = performance.now()
        setShown(text)
      },
      Math.max(0, interval - (performance.now() - last.current))
    )
    return () => clearTimeout(t)
  }, [text, shown])
  return shown
}

function InlineNodes({ nodes }: { nodes: Inline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <Fragment key={i}>{n.text}</Fragment>
          case 'code':
            return <code key={i}>{n.text}</code>
          case 'strong':
            return (
              <strong key={i}>
                <InlineNodes nodes={n.children} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <InlineNodes nodes={n.children} />
              </em>
            )
          case 'link':
            // Links stay text: the address is shown, never opened from here.
            return (
              <span key={i} className="md-link" title={n.href}>
                <InlineNodes nodes={n.children} />
                {n.href && !/^#/.test(n.href) && <span className="md-href"> ({n.href})</span>}
              </span>
            )
        }
      })}
    </>
  )
}

function List({ list }: { list: ListBlock }): React.JSX.Element {
  const items = list.items.map((item, i) => (
    <li key={i}>
      <InlineNodes nodes={item.children} />
      {item.sub && <List list={item.sub} />}
    </li>
  ))
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>
}

function Blocks({ blocks }: { blocks: Block[] }): React.JSX.Element {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const Tag = `h${Math.min(b.level + 1, 6)}` as 'h2'
            return (
              <Tag key={i}>
                <InlineNodes nodes={b.children} />
              </Tag>
            )
          }
          case 'paragraph':
            return (
              <p key={i}>
                <InlineNodes nodes={b.children} />
              </p>
            )
          case 'list':
            return <List key={i} list={b} />
          case 'code':
            return (
              <pre key={i} className="md-code">
                <code>{b.text}</code>
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={i}>
                <Blocks blocks={b.children} />
              </blockquote>
            )
          case 'hr':
            return <hr key={i} />
        }
      })}
    </>
  )
}

/** Renders Markdown text as React elements (no HTML injection). */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const shown = useThrottled(text)
  const head = shown.length > MAX_MARKDOWN_CHARS ? shown.slice(0, MAX_MARKDOWN_CHARS) : shown
  const blocks = useMemo(() => parseMarkdown(head), [head])
  return (
    <div className="markdown">
      <Blocks blocks={blocks} />
      {shown.length > MAX_MARKDOWN_CHARS && (
        <pre className="md-rest">{shown.slice(MAX_MARKDOWN_CHARS)}</pre>
      )}
    </div>
  )
}
