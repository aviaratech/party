import { describe, expect, it, vi } from 'vitest'
import { PartyClient, type PartyLifecycleSource } from '../core/PartyClient.js'
import type { PartyTransportClient, PartyTransportHandlers } from '../transport/types.js'
import {
  DEFAULT_PARTY_REQUEST_TIMEOUT_MS,
  MAX_PARTY_CHANNEL_ENVELOPE_BYTES,
  PartyChannelRegistry,
  parsePartyChannelEnvelope,
} from './channels.js'

type TestPayload = {
  value: string
  claimedSource?: string
}

function serializeTestPayload(payload: TestPayload) {
  return JSON.stringify(payload) ?? ''
}

function parseTestPayload(serialized: string): TestPayload | null {
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).value !== 'string'
    ) {
      return null
    }
    const record = parsed as Record<string, unknown>
    if (record.claimedSource !== undefined && typeof record.claimedSource !== 'string') {
      return null
    }
    return {
      value: record.value as string,
      ...(typeof record.claimedSource === 'string' ? { claimedSource: record.claimedSource } : {}),
    }
  } catch {
    return null
  }
}

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
  private listeners = new Set<() => void>()

  isForeground() {
    return true
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) listener()
  }
}

async function acknowledgeLatestProbe(
  transport: FakeTransport,
  handlers: PartyTransportHandlers,
  transportPeerId: string,
) {
  const call = transport.sendControl.mock.calls.at(-1)
  if (!call) throw new Error('Expected Party liveness probe')
  const probe = JSON.parse(String(call[0])) as {
    version: 1
    type: 'probe'
    requestId: string
    generation: number
  }
  await handlers.onControlMessage?.(JSON.stringify({ ...probe, type: 'ack' }), transportPeerId)
  await Promise.resolve()
}

async function exposePeer(
  client: PartyClient,
  transport: FakeTransport,
  handlers: PartyTransportHandlers,
  transportPeerId: string,
) {
  handlers.onPeerJoin?.(transportPeerId)
  await Promise.resolve()
  await acknowledgeLatestProbe(transport, handlers, transportPeerId)
  await Promise.resolve()
  const peer = client.getSnapshot().peers.at(-1)
  if (!peer) throw new Error('Expected verified Party peer')
  return peer.connectionId
}

function messageEnvelope(channel: string, payload: string) {
  return JSON.stringify({
    version: 1,
    type: 'message',
    channel,
    payload,
  })
}

describe('PartyClient channels', () => {
  it('maps targeted/broadcast traffic to opaque connections and supplies source identity separately', async () => {
    let handlers: PartyTransportHandlers | null = null
    const transport = new FakeTransport()
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
    })
    const channel = client.channel<TestPayload>({
      id: 'consumer-control',
      maxPayloadBytes: 256,
      serialize: serializeTestPayload,
      parse: parseTestPayload,
    })
    const received = vi.fn()
    channel.subscribe(received)

    await client.start()
    const firstConnectionId = await exposePeer(client, transport, handlers!, 'transport-secret-a')
    const secondConnectionId = await exposePeer(client, transport, handlers!, 'transport-secret-b')

    transport.send.mockClear()
    await channel.send({ value: 'targeted' }, { to: firstConnectionId })
    expect(transport.send).toHaveBeenLastCalledWith(expect.any(String), 'transport-secret-a')

    await channel.send({ value: 'broadcast' })
    expect(transport.send).toHaveBeenLastCalledWith(expect.any(String), [
      'transport-secret-a',
      'transport-secret-b',
    ])

    await handlers!.onMessage?.(
      messageEnvelope(
        'consumer-control',
        JSON.stringify({
          value: 'incoming',
          claimedSource: secondConnectionId,
        }),
      ),
      'transport-secret-a',
    )

    expect(received).toHaveBeenCalledWith({
      payload: {
        value: 'incoming',
        claimedSource: secondConnectionId,
      },
      sourceConnectionId: firstConnectionId,
    })
    expect(firstConnectionId).not.toBe('transport-secret-a')
    await client.dispose()
  })

  it('rejects malformed, unknown, and channel-oversize envelopes before the consumer parser', async () => {
    let handlers: PartyTransportHandlers | null = null
    const transport = new FakeTransport()
    const parse = vi.fn(parseTestPayload)
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
    })
    client.channel<TestPayload>({
      id: 'bounded',
      maxPayloadBytes: 16,
      serialize: serializeTestPayload,
      parse,
    })

    await client.start()
    await exposePeer(client, transport, handlers!, 'transport-secret')

    await handlers!.onMessage?.(
      JSON.stringify({
        version: 1,
        type: 'message',
        channel: 'bounded',
        payload: JSON.stringify({ value: 'ok' }),
        unexpected: true,
      }),
      'transport-secret',
    )
    await handlers!.onMessage?.(
      messageEnvelope('unknown', JSON.stringify({ value: 'ok' })),
      'transport-secret',
    )
    await handlers!.onMessage?.(messageEnvelope('bounded', 'x'.repeat(17)), 'transport-secret')
    await handlers!.onMessage?.(
      JSON.stringify({
        version: 2,
        type: 'message',
        channel: 'bounded',
        payload: JSON.stringify({ value: 'ok' }),
      }),
      'transport-secret',
    )

    expect(parse).not.toHaveBeenCalled()
    expect(parsePartyChannelEnvelope('x'.repeat(MAX_PARTY_CHANNEL_ENVELOPE_BYTES + 1))).toBeNull()
    await client.dispose()
  })

  it('correlates requests to the expected source and returns a validated response', async () => {
    let handlers: PartyTransportHandlers | null = null
    const transport = new FakeTransport()
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
    })
    const channel = client.channel<TestPayload>({
      id: 'rpc',
      maxPayloadBytes: 256,
      serialize: serializeTestPayload,
      parse: parseTestPayload,
    })

    await client.start()
    const firstConnectionId = await exposePeer(client, transport, handlers!, 'transport-secret-a')
    await exposePeer(client, transport, handlers!, 'transport-secret-b')

    transport.send.mockClear()
    const pending = channel.request(
      { value: 'question' },
      { to: firstConnectionId, timeoutMs: 1_000 },
    )
    await Promise.resolve()

    const outgoing = transport.send.mock.calls.at(-1)
    const request = parsePartyChannelEnvelope(String(outgoing?.[0]))
    if (!request || request.type !== 'request') throw new Error('Expected Party request envelope')

    await handlers!.onMessage?.(
      JSON.stringify({
        ...request,
        type: 'response',
        payload: JSON.stringify({ value: 'wrong-peer' }),
      }),
      'transport-secret-b',
    )

    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await handlers!.onMessage?.(
      JSON.stringify({
        ...request,
        type: 'response',
        payload: JSON.stringify({ value: 'answer' }),
      }),
      'transport-secret-a',
    )

    await expect(pending).resolves.toEqual({
      payload: { value: 'answer' },
      sourceConnectionId: firstConnectionId,
    })
    await client.dispose()
  })

  it('uses a bounded request timeout when no correlated response arrives', async () => {
    vi.useFakeTimers()
    try {
      let handlers: PartyTransportHandlers | null = null
      const transport = new FakeTransport()
      const client = new PartyClient({
        createTransport: (nextHandlers) => {
          handlers = nextHandlers
          return transport
        },
      })
      const channel = client.channel<TestPayload>({
        id: 'timeout',
        maxPayloadBytes: 256,
        serialize: serializeTestPayload,
        parse: parseTestPayload,
      })

      await client.start()
      const connectionId = await exposePeer(client, transport, handlers!, 'transport-secret')
      const pending = channel.request({ value: 'question' }, { to: connectionId })

      const assertion = expect(pending).rejects.toThrow(
        `Party request timed out after ${DEFAULT_PARTY_REQUEST_TIMEOUT_MS}ms`,
      )
      await vi.advanceTimersByTimeAsync(DEFAULT_PARTY_REQUEST_TIMEOUT_MS)
      await assertion
      await client.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes inbound requests to one handler and targets the response to the transport source', async () => {
    let handlers: PartyTransportHandlers | null = null
    const transport = new FakeTransport()
    const client = new PartyClient({
      createTransport: (nextHandlers) => {
        handlers = nextHandlers
        return transport
      },
    })
    const channel = client.channel<TestPayload>({
      id: 'responder',
      maxPayloadBytes: 256,
      serialize: serializeTestPayload,
      parse: parseTestPayload,
    })
    const handler = vi.fn(async ({ payload, sourceConnectionId }) => ({
      value: `${payload.value}:${sourceConnectionId}`,
    }))
    channel.onRequest(handler)

    await client.start()
    const connectionId = await exposePeer(client, transport, handlers!, 'transport-secret')
    transport.send.mockClear()

    await handlers!.onMessage?.(
      JSON.stringify({
        version: 1,
        type: 'request',
        channel: 'responder',
        requestId: 'request_1_77',
        payload: JSON.stringify({ value: 'ping' }),
      }),
      'transport-secret',
    )

    expect(handler).toHaveBeenCalledWith({
      payload: { value: 'ping' },
      sourceConnectionId: connectionId,
    })
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.send.mock.calls[0]?.[1]).toBe('transport-secret')
    const response = parsePartyChannelEnvelope(String(transport.send.mock.calls[0]?.[0]))
    expect(response).toMatchObject({
      type: 'response',
      channel: 'responder',
      requestId: 'request_1_77',
    })
    await client.dispose()
  })
})

describe('Party channel generation guards', () => {
  it('cancels requests from an obsolete generation and ignores their stale responses', async () => {
    let generation = 1
    const activeConnections = new Set(['connection-a'])
    const sent: Array<{ serialized: string; target?: string | readonly string[] | null }> = []
    const registry = new PartyChannelRegistry({
      generation: () => generation,
      isGenerationActive: (candidate) => candidate === generation,
      isConnectionActive: (connectionId) => activeConnections.has(connectionId),
      send: async (serialized, target) => {
        sent.push({ serialized, target })
      },
    })
    const channel = registry.channel<TestPayload>({
      id: 'generation-safe',
      maxPayloadBytes: 256,
      serialize: serializeTestPayload,
      parse: parseTestPayload,
    })

    const stale = channel.request({ value: 'old' }, { to: 'connection-a', timeoutMs: 1_000 })
    const staleAssertion = expect(stale).rejects.toThrow(/generation ended/i)
    const staleEnvelope = parsePartyChannelEnvelope(sent.at(-1)?.serialized ?? '')
    if (!staleEnvelope || staleEnvelope.type !== 'request') {
      throw new Error('Expected stale request envelope')
    }

    registry.cancelForGeneration(1)
    await staleAssertion
    generation = 2

    const current = channel.request({ value: 'new' }, { to: 'connection-a', timeoutMs: 1_000 })
    const currentEnvelope = parsePartyChannelEnvelope(sent.at(-1)?.serialized ?? '')
    if (!currentEnvelope || currentEnvelope.type !== 'request') {
      throw new Error('Expected current request envelope')
    }

    await registry.handleIncoming(
      generation,
      {
        ...staleEnvelope,
        type: 'response',
        payload: JSON.stringify({ value: 'stale-answer' }),
      },
      'connection-a',
    )

    let settled = false
    void current.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await registry.handleIncoming(
      generation,
      {
        ...currentEnvelope,
        type: 'response',
        payload: JSON.stringify({ value: 'current-answer' }),
      },
      'connection-a',
    )

    await expect(current).resolves.toEqual({
      payload: { value: 'current-answer' },
      sourceConnectionId: 'connection-a',
    })
    registry.dispose()
  })

  it('keeps registered channels usable across a clean Party transport recovery', async () => {
    const lifecycle = new FakeLifecycle()
    const firstTransport = new FakeTransport()
    const secondTransport = new FakeTransport()
    const handlers: PartyTransportHandlers[] = []
    const transports = [firstTransport, secondTransport]
    let index = 0
    const client = new PartyClient({
      lifecycle,
      createTransport: (nextHandlers) => {
        handlers.push(nextHandlers)
        const transport = transports[index++]
        if (!transport) throw new Error('Unexpected Party transport generation')
        return transport
      },
    })
    const channel = client.channel<TestPayload>({
      id: 'persistent-channel',
      maxPayloadBytes: 256,
      serialize: serializeTestPayload,
      parse: parseTestPayload,
    })

    await client.start()
    const oldConnectionId = await exposePeer(client, firstTransport, handlers[0]!, 'transport-old')

    handlers[0]!.onPeerLeave?.('transport-old')
    lifecycle.emit()
    await vi.waitFor(() => expect(secondTransport.start).toHaveBeenCalledTimes(1))

    const newConnectionId = await exposePeer(client, secondTransport, handlers[1]!, 'transport-new')
    await channel.send({ value: 'after-recovery' }, { to: newConnectionId })

    expect(oldConnectionId).not.toBe(newConnectionId)
    expect(secondTransport.send).toHaveBeenCalledWith(expect.any(String), 'transport-new')
    await client.dispose()
  })
})
