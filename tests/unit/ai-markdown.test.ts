import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, MAX_MARKDOWN_CHARS } from '../../src/renderer/src/components/ai/Markdown'
import {
  MAX_DEPTH,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
  type ListBlock
} from '../../src/renderer/src/components/ai/mdParse'

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists, code and quotes', () => {
    const blocks = parseMarkdown(
      [
        '## Summary',
        'First line',
        'continues here.',
        '',
        '- one',
        '- two',
        '  - nested',
        '1. first',
        '2. second',
        '',
        '```ts',
        'const a = 1',
        '',
        'const b = 2',
        '```',
        '> quoted',
        '---'
      ].join('\n')
    )
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
      'hr'
    ])
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: 'First line continues here.' }]
    })
    const list = blocks[2]
    expect(list.type === 'list' && list.items[1].sub?.items[0].children).toEqual([
      { type: 'text', text: 'nested' }
    ])
    expect(blocks[3]).toMatchObject({ ordered: true, start: 1 })
    expect(blocks[4]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' })
  })

  it('parses inline code, bold, italic and links', () => {
    expect(
      parseInline('Use `a*b*` **bold _it_** and *em* [docs](https://x.y) snake_case_name')
    ).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'code', text: 'a*b*' },
      { type: 'text', text: ' ' },
      {
        type: 'strong',
        children: [
          { type: 'text', text: 'bold ' },
          { type: 'em', children: [{ type: 'text', text: 'it' }] }
        ]
      },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'em' }] },
      { type: 'text', text: ' ' },
      { type: 'link', children: [{ type: 'text', text: 'docs' }], href: 'https://x.y' },
      { type: 'text', text: ' snake_case_name' }
    ])
  })

  it('tolerates unterminated markup', () => {
    expect(parseInline('a **b `c')).toEqual([{ type: 'text', text: 'a **b `c' }])
    expect(parseMarkdown('```\nnever closed')).toEqual([
      { type: 'code', lang: '', text: 'never closed' }
    ])
  })
})

/** Deepest nesting of quotes, lists and inline markup in a parsed tree. */
function depthOf(blocks: Block[]): number {
  const inline = (nodes: Inline[]): number =>
    Math.max(0, ...nodes.map((n) => ('children' in n ? 1 + inline(n.children) : 0)))
  const list = (l: ListBlock): number =>
    1 +
    Math.max(0, ...l.items.map((it) => Math.max(inline(it.children), it.sub ? list(it.sub) : 0)))
  return Math.max(
    0,
    ...blocks.map((b) =>
      b.type === 'quote'
        ? 1 + depthOf(b.children)
        : b.type === 'list'
          ? list(b)
          : 'children' in b
            ? inline(b.children)
            : 0
    )
  )
}

describe('untrusted Markdown stays bounded', () => {
  it('caps quote, list and inline nesting', () => {
    const quotes = parseMarkdown('>'.repeat(10_000) + ' deep')
    expect(depthOf(quotes)).toBeLessThanOrEqual(MAX_DEPTH + 1)
    expect(JSON.stringify(quotes)).toContain('deep')
    const lists = parseMarkdown(
      Array.from({ length: 2000 }, (_, i) => ' '.repeat(i) + '- x').join('\n')
    )
    expect(depthOf(lists)).toBeLessThanOrEqual(MAX_DEPTH + 1)
    const inline = parseInline('**'.repeat(5000) + 'x' + '**'.repeat(5000))
    expect(depthOf([{ type: 'paragraph', children: inline }])).toBeLessThanOrEqual(MAX_DEPTH)
  })

  it('parses pathological paragraphs in linear time', () => {
    const n = 64 * 1024
    const patterns = ['**a ', '__a ', '*a ', '_a ', '[a](', '[a', '`', '``a ', '# ##']
    for (const p of patterns) {
      const text = p.repeat(Math.ceil(n / p.length)).slice(0, n)
      // The fastest of three runs: the other test files spawn git meanwhile, and a busy
      // machine can stall one run. A quadratic parser is slow on every run (seconds).
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const start = performance.now()
        parseMarkdown(text)
        parseMarkdown('# ' + text)
        best = Math.min(best, performance.now() - start)
      }
      expect(best, p).toBeLessThan(250)
    }
  })

  it('keeps headings with closing hashes and words ending with #', () => {
    expect(parseMarkdown('## Title ##')).toEqual([
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Title' }] }
    ])
    expect(parseMarkdown('# Use C#')[0]).toEqual({
      type: 'heading',
      level: 1,
      children: [{ type: 'text', text: 'Use C#' }]
    })
  })

  it('still parses links with titles and nested emphasis', () => {
    expect(parseInline('[a *b*](x "t") and `` c`d ``')).toEqual([
      {
        type: 'link',
        children: [
          { type: 'text', text: 'a ' },
          { type: 'em', children: [{ type: 'text', text: 'b' }] }
        ],
        href: 'x'
      },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'c`d' }
    ])
    expect(parseInline('a*b* c**')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'em', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' c**' }
    ])
  })
})

describe('Markdown component', () => {
  it('shows text past the cap as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: 'x'.repeat(MAX_MARKDOWN_CHARS) + '**tail**' })
    )
    expect(html).toContain('<pre class="md-rest">**tail**</pre>')
  })

  it('renders elements and escapes HTML instead of injecting it', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: '# Title\n\n<img src=x onerror=alert(1)> **b**\n\n[click](javascript:alert(1))'
      })
    )
    expect(html).toContain('<h2>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('<strong>')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<img')
  })
})
