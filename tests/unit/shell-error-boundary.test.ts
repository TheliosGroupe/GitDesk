import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../src/renderer/src/components/shell/ErrorBoundary'

// No DOM here: the boundary's own logic, driven by hand the way React drives it.
describe('ErrorBoundary', () => {
  const make = (): { boundary: ErrorBoundary; fallback: ReturnType<typeof vi.fn> } => {
    const fallback = vi.fn((error: Error) => createElement('p', null, error.message))
    const boundary = new ErrorBoundary({ fallback, children: createElement('main') })
    // setState outside React: apply it directly.
    boundary.setState = ((s: ErrorBoundary['state']) =>
      Object.assign(boundary.state, s)) as ErrorBoundary['setState']
    return { boundary, fallback }
  }

  it('shows the children until something throws, then the fallback', () => {
    const { boundary, fallback } = make()
    expect(boundary.render()).toMatchObject({ type: 'main' })
    Object.assign(boundary.state, ErrorBoundary.getDerivedStateFromError(new TypeError('boom')))
    expect(boundary.render()).toMatchObject({ type: 'p', props: { children: 'boom' } })
    expect(fallback).toHaveBeenCalledWith(expect.any(TypeError), boundary.retry)
  })

  it('turns thrown non-errors into errors', () => {
    expect(ErrorBoundary.getDerivedStateFromError('text').error).toBeInstanceOf(Error)
    expect(ErrorBoundary.getDerivedStateFromError(undefined).error.message).toBe('undefined')
  })

  it('retry renders the children again', () => {
    const { boundary } = make()
    Object.assign(boundary.state, ErrorBoundary.getDerivedStateFromError(new Error('x')))
    boundary.retry()
    expect(boundary.render()).toMatchObject({ type: 'main' })
  })

  it('recovers when its reset key changes, and only then', () => {
    const { boundary } = make()
    const props = (resetKey: string): ErrorBoundary['props'] => ({ ...boundary.props, resetKey })
    Object.assign(boundary, { props: props('projects') })
    Object.assign(boundary.state, ErrorBoundary.getDerivedStateFromError(new Error('x')))
    boundary.componentDidUpdate(props('projects'))
    expect(boundary.state.error).not.toBeNull()
    boundary.componentDidUpdate(props('launchpad'))
    expect(boundary.state.error).toBeNull()
  })

  it('still reports the crash', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    make().boundary.componentDidCatch(new Error('x'), { componentStack: '\n at View' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
