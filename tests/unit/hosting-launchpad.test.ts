// The Launchpad always finishes: an account whose API never answers becomes an error entry
// after the deadline, the other sources still list, and the next load starts afresh.

import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ stall: true, calls: 0 }))

vi.mock('electron', () => ({
  app: { getPath: () => '.', isPackaged: false },
  net: {},
  session: {}
}))
vi.mock('../../src/main/accounts', () => ({
  allAuth: () => [
    { account: { id: 'stuck', provider: 'gitlab', host: 'gitlab.example.test' }, token: 't' },
    { account: { id: 'fine', provider: 'gitlab', host: 'gitlab.example.test' }, token: 't' }
  ]
}))
vi.mock('../../src/main/store', () => ({ loadState: () => ({ repos: [] }) }))
vi.mock('../../src/main/hosting/trackers', () => ({
  trackerIssues: async () => ({ issues: [], errors: [] })
}))
vi.mock('../../src/main/hosting/context', () => ({
  accountLabel: (a: { account: { id: string } }) => a.account.id,
  localRepoIndex: async () => new Map(),
  localRepoFor: () => null,
  originRef: async () => null,
  clientOf: (a: { account: { id: string } }) => ({
    launchpad: () => {
      state.calls++
      if (a.account.id === 'stuck' && state.stall) return new Promise(() => undefined)
      return Promise.resolve([
        {
          id: `gitlab:${a.account.id}:g/p!1:mine`,
          group: 'mine',
          source: 'gitlab',
          accountId: a.account.id,
          accountLabel: a.account.id,
          host: 'gitlab.example.test',
          repo: 'g/p',
          number: 1,
          key: '!1',
          title: 'T',
          url: 'https://gitlab.example.test/g/p/-/merge_requests/1',
          author: 'a',
          authorAvatar: null,
          updatedAt: 1,
          draft: false,
          ci: null,
          review: null,
          state: 'open',
          headRef: 'f',
          baseRef: 'main',
          cloneUrl: null
        }
      ])
    }
  })
}))

afterEach(() => vi.useRealTimers())

describe('Launchpad deadline', () => {
  it('reports a stalled account as an error and recovers on the next load', async () => {
    vi.useFakeTimers()
    const { launchpad } = await import('../../src/main/hosting/launchpad')
    const pending = launchpad(true)
    await vi.advanceTimersByTimeAsync(46_000)
    const data = await pending
    expect(data.items.map((i) => i.accountId)).toEqual(['fine'])
    expect(data.errors).toEqual([{ source: 'stuck', error: 'stuck did not answer in time.' }])

    state.stall = false
    const again = await launchpad(true)
    expect(again.items.map((i) => i.accountId).sort()).toEqual(['fine', 'stuck'])
    expect(again.errors).toEqual([])
    expect(state.calls).toBe(4)
  })
})
