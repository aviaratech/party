import { describe, expect, it, vi } from 'vitest'
import { createBrowserPartyLifecycleSource } from '../browser/lifecycle.js'
import {
  DEFAULT_PARTY_PROBE_TIMEOUT_MS,
  DEFAULT_PARTY_RECOVERY_TIMEOUT_MS,
  PartyClient,
  type PartyHandshakeContext,
  type PartyLifecycleSource,
} from './PartyClient.js'
import type { PartyTransportClient, PartyTransportHandlers } from '../transport/types.js'

class FakeTransport implements PartyTransportClient {
  readonly start = vi.fn<PartyTransportClient['start']>(async () => undefined)
  readonly send = vi.fn<PartyTransportClient['send']>(async () => undefined)
  readonly sendControl = vi.fn<PartyTransportClient['sendControl']>(async () => undefined)
  readonly disconnectPeer = vi.fn<PartyTransportClient['disconnectPeer']>(() => undefined)
  readonly dispose = vi.fn<PartyTransportClient['dispose']>(async () => ({ requiresReload: false }))

  peerIds() {
    return []
  }
}

class FakeLifecycle implements PartyLifecycleSource {
  foreground = true
  private listeners = new Set<() => void>()

  isForeground() {
    return this.foreground
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) listener()
  }
}

function setup(
  overrides: Partial<{
    lifecycle: PartyLifecycleSource
    onReloadRequired: () => void
    disposeResult: { requiresReload: boolean }
  }> = {},
) {
  let handlers: PartyTransportHandlers | null = null
  const transport = new FakeTransport()
  if (overrides.disposeResult) {
    transport.dispose.mockResolvedValue(overrides.disposeResult)
  }
  const client = new PartyClient({
    createTransport: (nextHandlers) => {
      handlers = nextHandlers
      return transport
    },
    lifecycle: overrides.lifecycle,
    onReloadRequired: overrides.onReloadRequired,
  })
  return {
    client,
    transport,
    handlers: () => {
      if (!handlers) throw new Error('transport handlers not created')
      return handlers
    },
  }
}

async function acknowledgeLatestProbe(
  transport: FakeTransport,
  handlers: PartyTransportHandlers,
  transportPeerId = 'transport-peer-secret',
) {
  const call = transport.sendControl.mock.calls.at(-1)
  if (!call) throw new Error('expected a control probe')
  const parsed = JSON.parse(String(call[0])) as {
    version: 1
    type: 'probe'
    requestId: string
    generation: number
  }
  await handlers.onControlMessage?.(JSON.stringify({ ...parsed, type: 'ack' }), transportPeerId)
  await Promise.resolve()
  return parsed
}

async function connectVerifiedPeer(
  client: PartyClient,
  transport: FakeTransport,
  handlers: PartyTransportHandlers,
  transportPeerId = 'transport-peer-secret',
) {
  handlers.onPeerJoin?.(transportPeerId)
  await Promise.resolve()
  await acknowledgeLatestProbe(transport, handlers, transportPeerId)
  await Promise.resolve()
  expect(client.getSnapshot().state).toBe('online')
}

describe('PartyClient', () => {
  it('keeps immutable snapshot identity stable until state actually changes', async () => {
    const { client, transport } = setup()
    const initial = client.getSnapshot()
    expect(client.getSnapshot()).toBe(initial)
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.peers)).toBe(true)

    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    await client.start()
    const started = client.getSnapshot()

    expect(started).not.toBe(initial)
    expect(started.state).toBe('connecting')
    expect(client.getSnapshot()).toBe(started)
    expect(listener).toHaveBeenCalledTimes(1)

    await client.start()
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    await client.dispose()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('exposes an opaque connection only after a correlated bidirectional control proof', async () => {
    const onPeerJoin = vi.fn()
    let handlers: PartyTransportHandlers | null = null
    const transport = new FakeTransport()
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
      onPeerJoin,
    })

    await client.start()
    handlers!.onPeerJoin?.('transport-peer-secret')
    await Promise.resolve()

    expect(client.getSnapshot().state).toBe('connecting')
    expect(client.getSnapshot().peers).toEqual([])
    const probe = await acknowledgeLatestProbe(transport, handlers!, 'transport-peer-secret')
    expect(probe.type).toBe('probe')
    expect(client.getSnapshot().state).toBe('online')
    expect(client.getSnapshot().peers).toHaveLength(1)
    expect(client.getSnapshot().peers[0]?.connectionId).not.toBe('transport-peer-secret')
    expect(onPeerJoin).toHaveBeenCalledWith(client.getSnapshot().peers[0]?.connectionId)
  })

  it('passes an opaque connection ID into the consumer handshake gate', async () => {
    let handlers: PartyTransportHandlers | null = null
    const handshake = vi.fn(async (_context: PartyHandshakeContext) => undefined)
    const transport = new FakeTransport()
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
      handshake,
    })
    await client.start()

    await handlers!.onPeerHandshake?.(
      'transport-peer-secret',
      async () => undefined,
      async () => ({ data: 'handshake' }),
      true,
    )

    expect(handshake).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: expect.stringMatching(/^connection_/),
        isInitiator: true,
      }),
    )
    expect(handshake.mock.calls[0]?.[0].connectionId).not.toBe('transport-peer-secret')
  })

  it('coalesces foreground recovery and returns online only after a fresh control proof', async () => {
    const lifecycle = new FakeLifecycle()
    const { client, transport, handlers } = setup({ lifecycle })
    await client.start()
    await connectVerifiedPeer(client, transport, handlers())
    transport.sendControl.mockClear()

    lifecycle.emit()
    lifecycle.emit()
    await Promise.resolve()

    expect(client.getSnapshot().state).toBe('recovering')
    expect(transport.sendControl).toHaveBeenCalledTimes(1)

    await acknowledgeLatestProbe(transport, handlers())
    await Promise.resolve()
    expect(client.getSnapshot().state).toBe('online')
  })

  it('recycles one interrupted transport generation at a time and ignores obsolete callbacks', async () => {
    const lifecycle = new FakeLifecycle()
    const firstTransport = new FakeTransport()
    const secondTransport = new FakeTransport()
    const handlers: PartyTransportHandlers[] = []
    let finishFirstDispose!: (result: { requiresReload: boolean }) => void
    firstTransport.dispose.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFirstDispose = resolve
        }),
    )

    const transports = [firstTransport, secondTransport]
    let createCount = 0
    const client = new PartyClient({
      lifecycle,
      createTransport: (nextHandlers) => {
        handlers.push(nextHandlers)
        const transport = transports[createCount++]
        if (!transport) throw new Error('unexpected transport generation')
        return transport
      },
    })

    await client.start()
    await connectVerifiedPeer(client, firstTransport, handlers[0]!)
    handlers[0]!.onPeerLeave?.('transport-peer-secret')
    expect(client.getSnapshot().state).toBe('interrupted')

    lifecycle.emit()
    lifecycle.emit()

    expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 2 })
    expect(firstTransport.dispose).toHaveBeenCalledTimes(1)
    expect(createCount).toBe(1)

    finishFirstDispose({ requiresReload: false })
    await vi.waitFor(() => expect(secondTransport.start).toHaveBeenCalledTimes(1))

    expect(createCount).toBe(2)
    expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 2 })

    handlers[0]!.onPeerJoin?.('obsolete-peer')
    await Promise.resolve()
    expect(secondTransport.sendControl).not.toHaveBeenCalled()

    handlers[1]!.onPeerJoin?.('fresh-peer')
    await Promise.resolve()
    await acknowledgeLatestProbe(secondTransport, handlers[1]!, 'fresh-peer')
    await Promise.resolve()

    expect(client.getSnapshot()).toMatchObject({ state: 'online', generation: 2 })
    expect(client.getSnapshot().peers).toHaveLength(1)
    await client.dispose()
  })

  it('requires reload when a replacement recovery generation never regains a verified peer', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new FakeLifecycle()
      const onReloadRequired = vi.fn()
      const firstTransport = new FakeTransport()
      const secondTransport = new FakeTransport()
      const handlers: PartyTransportHandlers[] = []
      const transports = [firstTransport, secondTransport]
      let createCount = 0
      const client = new PartyClient({
        lifecycle,
        onReloadRequired,
        createTransport: (nextHandlers) => {
          handlers.push(nextHandlers)
          const transport = transports[createCount++]
          if (!transport) throw new Error('unexpected transport generation')
          return transport
        },
      })

      await client.start()
      await connectVerifiedPeer(client, firstTransport, handlers[0]!)
      handlers[0]!.onPeerLeave?.('transport-peer-secret')
      expect(client.getSnapshot().state).toBe('interrupted')

      lifecycle.emit()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(secondTransport.start).toHaveBeenCalledTimes(1)
      expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 2 })

      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_RECOVERY_TIMEOUT_MS - 1)
      expect(onReloadRequired).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(client.getSnapshot()).toMatchObject({ state: 'reload-required', generation: 2 })
      expect(onReloadRequired).toHaveBeenCalledTimes(1)

      await client.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the replacement recovery deadline after the fresh peer verifies', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new FakeLifecycle()
      const onReloadRequired = vi.fn()
      const firstTransport = new FakeTransport()
      const secondTransport = new FakeTransport()
      const handlers: PartyTransportHandlers[] = []
      const transports = [firstTransport, secondTransport]
      let createCount = 0
      const client = new PartyClient({
        lifecycle,
        onReloadRequired,
        createTransport: (nextHandlers) => {
          handlers.push(nextHandlers)
          const transport = transports[createCount++]
          if (!transport) throw new Error('unexpected transport generation')
          return transport
        },
      })

      await client.start()
      await connectVerifiedPeer(client, firstTransport, handlers[0]!)
      handlers[0]!.onPeerLeave?.('transport-peer-secret')
      lifecycle.emit()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(secondTransport.start).toHaveBeenCalledTimes(1)
      handlers[1]!.onPeerJoin?.('fresh-peer')
      await Promise.resolve()
      await acknowledgeLatestProbe(secondTransport, handlers[1]!, 'fresh-peer')
      await Promise.resolve()

      expect(client.getSnapshot()).toMatchObject({ state: 'online', generation: 2 })
      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_RECOVERY_TIMEOUT_MS)
      expect(onReloadRequired).not.toHaveBeenCalled()

      await client.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the replacement recovery deadline when the client is disposed', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new FakeLifecycle()
      const onReloadRequired = vi.fn()
      const firstTransport = new FakeTransport()
      const secondTransport = new FakeTransport()
      const handlers: PartyTransportHandlers[] = []
      const transports = [firstTransport, secondTransport]
      let createCount = 0
      const client = new PartyClient({
        lifecycle,
        onReloadRequired,
        createTransport: (nextHandlers) => {
          handlers.push(nextHandlers)
          const transport = transports[createCount++]
          if (!transport) throw new Error('unexpected transport generation')
          return transport
        },
      })

      await client.start()
      await connectVerifiedPeer(client, firstTransport, handlers[0]!)
      handlers[0]!.onPeerLeave?.('transport-peer-secret')
      lifecycle.emit()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 2 })
      await client.dispose()
      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_RECOVERY_TIMEOUT_MS)

      expect(onReloadRequired).not.toHaveBeenCalled()
      expect(client.getSnapshot().state).toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an obsolete revalidation after recovery advances the transport generation', async () => {
    const lifecycle = new FakeLifecycle()
    const firstTransport = new FakeTransport()
    const secondTransport = new FakeTransport()
    const handlers: PartyTransportHandlers[] = []
    const transports = [firstTransport, secondTransport]
    let createCount = 0
    const client = new PartyClient({
      lifecycle,
      createTransport: (nextHandlers) => {
        handlers.push(nextHandlers)
        const transport = transports[createCount++]
        if (!transport) throw new Error('unexpected transport generation')
        return transport
      },
    })

    await client.start()
    await connectVerifiedPeer(client, firstTransport, handlers[0]!)
    firstTransport.sendControl.mockClear()

    const obsoleteRevalidation = client.revalidate()
    await Promise.resolve()
    expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 1 })

    handlers[0]!.onPeerLeave?.('transport-peer-secret')
    expect(client.getSnapshot().state).toBe('interrupted')
    lifecycle.emit()

    await vi.waitFor(() => expect(secondTransport.start).toHaveBeenCalledTimes(1))
    await obsoleteRevalidation

    expect(client.getSnapshot()).toMatchObject({ state: 'recovering', generation: 2 })

    handlers[1]!.onPeerJoin?.('fresh-peer')
    await Promise.resolve()
    await acknowledgeLatestProbe(secondTransport, handlers[1]!, 'fresh-peer')
    await Promise.resolve()

    expect(client.getSnapshot()).toMatchObject({ state: 'online', generation: 2 })
    await client.dispose()
  })

  it('requires reload when failed foreground validation cannot safely recycle the transport', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new FakeLifecycle()
      const onReloadRequired = vi.fn()
      const { client, transport, handlers } = setup({
        lifecycle,
        onReloadRequired,
        disposeResult: { requiresReload: true },
      })
      await client.start()
      await connectVerifiedPeer(client, transport, handlers())
      transport.sendControl.mockClear()

      lifecycle.emit()
      await Promise.resolve()
      expect(client.getSnapshot().state).toBe('recovering')

      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_PROBE_TIMEOUT_MS)

      expect(client.getSnapshot()).toMatchObject({ state: 'reload-required', generation: 2 })
      expect(onReloadRequired).toHaveBeenCalledTimes(1)
      expect(transport.dispose).toHaveBeenCalledTimes(1)
      expect(transport.disconnectPeer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale or mismatched probe acknowledgements', async () => {
    vi.useFakeTimers()
    try {
      const { client, transport, handlers } = setup()
      await client.start()
      handlers().onPeerJoin?.('transport-peer-secret')
      await Promise.resolve()

      const call = transport.sendControl.mock.calls.at(-1)
      const probe = JSON.parse(String(call?.[0])) as {
        requestId: string
        generation: number
      }
      await handlers().onControlMessage?.(
        JSON.stringify({
          version: 1,
          type: 'ack',
          requestId: `${probe.requestId}_stale`,
          generation: probe.generation,
        }),
        'transport-peer-secret',
      )

      expect(client.getSnapshot().state).toBe('connecting')
      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_PROBE_TIMEOUT_MS)
      expect(client.getSnapshot().state).toBe('interrupted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed on unsafe transport disposal and ignores late callbacks', async () => {
    const { client, handlers } = setup({ disposeResult: { requiresReload: true } })
    await client.start()
    const result = await client.dispose()
    const disposedSnapshot = client.getSnapshot()

    expect(result).toEqual({ requiresReload: true })
    expect(disposedSnapshot.state).toBe('reload-required')

    handlers().onPeerJoin?.('late-peer')
    await handlers().onControlMessage?.(
      JSON.stringify({ version: 1, type: 'probe', requestId: 'probe_1_99', generation: 1 }),
      'late-peer',
    )
    await Promise.resolve()

    expect(client.getSnapshot()).toBe(disposedSnapshot)
  })
})

class FakeEventTarget {
  readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type))
    }
  }
}

describe('createBrowserPartyLifecycleSource', () => {
  it('emits only foreground visibility/pageshow/online signals and cleans up listeners', () => {
    const documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: 'hidden' })
    const windowTarget = new FakeEventTarget()
    const source = createBrowserPartyLifecycleSource({ documentTarget, windowTarget })
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)

    documentTarget.dispatch('visibilitychange')
    expect(listener).not.toHaveBeenCalled()

    documentTarget.visibilityState = 'visible'
    documentTarget.dispatch('visibilitychange')
    windowTarget.dispatch('pageshow')
    windowTarget.dispatch('online')
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    windowTarget.dispatch('online')
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
