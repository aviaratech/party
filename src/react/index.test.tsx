// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PartyClientSnapshot } from '../core/PartyClient.js'
import { useParty, usePartyPeers, usePartyStatus, type PartyExternalStore } from './index.js'

function snapshot(patch: Partial<PartyClientSnapshot> = {}): PartyClientSnapshot {
  return Object.freeze({
    state: 'connecting',
    generation: 1,
    peers: Object.freeze([]),
    error: null,
    ...patch,
  })
}

class FakePartyStore implements PartyExternalStore {
  private listeners = new Set<() => void>()

  constructor(private current: PartyClientSnapshot) {}

  getSnapshot() {
    return this.current
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(next: PartyClientSnapshot) {
    this.current = next
    for (const listener of this.listeners) listener()
  }

  listenerCount() {
    return this.listeners.size
  }
}

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>
}

describe('@aviaratech/party/react', () => {
  it('subscribes to the headless external store and returns its cached snapshot', () => {
    const initial = snapshot()
    const store = new FakePartyStore(initial)
    const { result, unmount } = renderHook(() => useParty(store))

    expect(result.current).toBe(initial)
    expect(store.listenerCount()).toBe(1)

    const next = snapshot({
      state: 'online',
      peers: Object.freeze([Object.freeze({ connectionId: 'connection_1_1' })]),
    })
    act(() => store.emit(next))

    expect(result.current).toBe(next)
    expect(result.current.state).toBe('online')

    unmount()
    expect(store.listenerCount()).toBe(0)
  })

  it('exposes status and peers without owning PartyClient lifecycle in StrictMode', () => {
    const store = new FakePartyStore(
      snapshot({
        state: 'online',
        peers: Object.freeze([Object.freeze({ connectionId: 'connection_1_1' })]),
      }),
    )

    const { result } = renderHook(
      () => ({
        status: usePartyStatus(store),
        peers: usePartyPeers(store),
      }),
      { wrapper: StrictModeWrapper },
    )

    expect(result.current.status).toBe('online')
    expect(result.current.peers).toEqual([{ connectionId: 'connection_1_1' }])
  })
})
