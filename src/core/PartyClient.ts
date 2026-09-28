import type {
  PartyTransportClient,
  PartyTransportHandlers,
  PartyTransportHandshakeReceive,
  PartyTransportHandshakeSend,
} from '../transport/types.js'
import {
  PartyChannelRegistry,
  type PartyChannel,
  type PartyChannelDefinition,
  type PartyChannelEnvelope,
} from '../protocol/channels.js'

export const DEFAULT_PARTY_PROBE_TIMEOUT_MS = 5_000
export const DEFAULT_PARTY_RECOVERY_TIMEOUT_MS = 30_000

const PARTY_CONTROL_VERSION = 1
const MAX_CONTROL_MESSAGE_BYTES = 256
const MAX_QUEUED_APPLICATION_MESSAGES_PER_PEER = 16

export type PartyConnectionState =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'interrupted'
  | 'recovering'
  | 'reload-required'
  | 'closed'
  | 'error'

export type PartyPeer = Readonly<{
  connectionId: string
}>

export type PartyClientSnapshot = Readonly<{
  state: PartyConnectionState
  generation: number
  peers: readonly PartyPeer[]
  error: string | null
}>

export type PartyLifecycleSource = {
  isForeground(): boolean
  subscribe(listener: () => void): () => void
}

export type PartyHandshakeContext = {
  connectionId: string
  send: PartyTransportHandshakeSend
  receive: PartyTransportHandshakeReceive
  isInitiator: boolean
}

export type PartyClientOptions = {
  createTransport(handlers: PartyTransportHandlers): PartyTransportClient
  handshake?: (context: PartyHandshakeContext) => Promise<void>
  lifecycle?: PartyLifecycleSource
  onPeerJoin?: (connectionId: string) => void
  onPeerLeave?: (connectionId: string) => void
  onJoinError?: (details: { error: string; connectionId: string | null }) => void
  onReloadRequired?: () => void
  probeTimeoutMs?: number
}

type PendingProbe = {
  generation: number
  transportPeerId: string
  resolve: (confirmed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

type ControlMessage =
  | { version: 1; type: 'probe'; requestId: string; generation: number }
  | { version: 1; type: 'ack'; requestId: string; generation: number }

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function parseControlMessage(data: string): ControlMessage | null {
  if (utf8ByteLength(data) > MAX_CONTROL_MESSAGE_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length !== 4 ||
    record.version !== PARTY_CONTROL_VERSION ||
    (record.type !== 'probe' && record.type !== 'ack') ||
    typeof record.requestId !== 'string' ||
    !/^probe_[a-z0-9_]{1,64}$/u.test(record.requestId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1
  ) {
    return null
  }

  return {
    version: PARTY_CONTROL_VERSION,
    type: record.type,
    requestId: record.requestId,
    generation: record.generation as number,
  }
}

function serializeControlMessage(message: ControlMessage) {
  return JSON.stringify(message)
}

function samePeerIds(left: readonly PartyPeer[], right: readonly PartyPeer[]) {
  if (left.length !== right.length) return false
  return left.every((peer, index) => peer.connectionId === right[index]?.connectionId)
}

export class PartyClient {
  private readonly options: PartyClientOptions
  private readonly subscribers = new Set<() => void>()
  private readonly verifiedConnectionIds = new Set<string>()
  private readonly connectionIdByTransportPeer = new Map<string, string>()
  private readonly transportPeerByConnectionId = new Map<string, string>()
  private readonly queuedApplicationMessages = new Map<
    string,
    Array<{ envelope: PartyChannelEnvelope; connectionId: string }>
  >()
  private readonly pendingProbes = new Map<string, PendingProbe>()
  private readonly channelRegistry: PartyChannelRegistry
  private readonly probeTimeoutMs: number
  private transport: PartyTransportClient | null = null
  private lifecycleUnsubscribe: (() => void) | null = null
  private startPromise: Promise<void> | null = null
  private lifecyclePromise: Promise<void> | null = null
  private recoveryPromise: Promise<boolean> | null = null
  private recoveryDeadline: {
    generation: number
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private disposePromise: Promise<{ requiresReload: boolean }> | null = null
  private generation = 0
  private nextConnectionSequence = 0
  private nextProbeSequence = 0
  private disposed = false
  private snapshot: PartyClientSnapshot = Object.freeze({
    state: 'idle',
    generation: 0,
    peers: Object.freeze([]),
    error: null,
  })

  constructor(options: PartyClientOptions) {
    this.options = options
    this.channelRegistry = new PartyChannelRegistry({
      generation: () => this.generation,
      isGenerationActive: (generation) => this.currentGeneration(generation),
      isConnectionActive: (connectionId) => this.verifiedConnectionIds.has(connectionId),
      send: (serialized, target) => this.sendApplicationEnvelope(serialized, target),
    })
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PARTY_PROBE_TIMEOUT_MS
    if (!Number.isFinite(this.probeTimeoutMs) || this.probeTimeoutMs <= 0) {
      throw new Error('Party probe timeout must be a positive finite number')
    }

    if (options.lifecycle) {
      this.lifecycleUnsubscribe = options.lifecycle.subscribe(() => {
        if (!options.lifecycle?.isForeground()) return
        this.lifecyclePromise ??= this.handleLifecycleSignal().finally(() => {
          this.lifecyclePromise = null
        })
      })
    }
  }

  getSnapshot() {
    return this.snapshot
  }

  subscribe(listener: () => void) {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  private clearRecoveryDeadline() {
    if (!this.recoveryDeadline) return
    clearTimeout(this.recoveryDeadline.timer)
    this.recoveryDeadline = null
  }

  private armRecoveryDeadline(generation: number) {
    this.clearRecoveryDeadline()
    const timer = setTimeout(() => {
      if (
        !this.recoveryDeadline ||
        this.recoveryDeadline.generation !== generation ||
        this.recoveryDeadline.timer !== timer
      ) {
        return
      }

      this.recoveryDeadline = null
      if (!this.currentGeneration(generation) || this.snapshot.state !== 'recovering') return
      this.requireReload()
    }, DEFAULT_PARTY_RECOVERY_TIMEOUT_MS)
    this.recoveryDeadline = { generation, timer }
  }

  private emitSnapshot(state: PartyConnectionState, error: string | null = null) {
    if (state !== 'recovering') this.clearRecoveryDeadline()
    const peers = Object.freeze(
      [...this.verifiedConnectionIds].map((connectionId) => Object.freeze({ connectionId })),
    )
    const next = Object.freeze({
      state,
      generation: this.generation,
      peers,
      error,
    }) satisfies PartyClientSnapshot

    if (
      this.snapshot.state === next.state &&
      this.snapshot.generation === next.generation &&
      this.snapshot.error === next.error &&
      samePeerIds(this.snapshot.peers, next.peers)
    ) {
      return
    }

    this.snapshot = next
    for (const subscriber of this.subscribers) subscriber()
  }

  private currentGeneration(generation: number) {
    return !this.disposed && generation === this.generation
  }

  private getOrCreateConnectionId(transportPeerId: string) {
    const existing = this.connectionIdByTransportPeer.get(transportPeerId)
    if (existing) return existing

    const connectionId = `connection_${this.generation}_${++this.nextConnectionSequence}`
    this.connectionIdByTransportPeer.set(transportPeerId, connectionId)
    this.transportPeerByConnectionId.set(connectionId, transportPeerId)
    return connectionId
  }

  private connectionId(transportPeerId: string) {
    return this.connectionIdByTransportPeer.get(transportPeerId) ?? null
  }

  private transportPeerId(connectionId: string) {
    return this.transportPeerByConnectionId.get(connectionId) ?? null
  }

  private cancelProbesForTransportPeer(transportPeerId: string) {
    for (const [requestId, pending] of this.pendingProbes.entries()) {
      if (pending.transportPeerId !== transportPeerId) continue
      clearTimeout(pending.timer)
      this.pendingProbes.delete(requestId)
      pending.resolve(false)
    }
  }

  private cancelAllProbes() {
    for (const pending of this.pendingProbes.values()) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.pendingProbes.clear()
  }

  private clearConnections(notify: boolean) {
    for (const transportPeerId of [...this.connectionIdByTransportPeer.keys()]) {
      this.removeConnection(transportPeerId, notify)
    }
    this.verifiedConnectionIds.clear()
    this.connectionIdByTransportPeer.clear()
    this.transportPeerByConnectionId.clear()
    this.queuedApplicationMessages.clear()
  }

  private removeConnection(transportPeerId: string, notify: boolean) {
    const connectionId = this.connectionIdByTransportPeer.get(transportPeerId)
    if (!connectionId) return

    this.cancelProbesForTransportPeer(transportPeerId)
    this.connectionIdByTransportPeer.delete(transportPeerId)
    this.transportPeerByConnectionId.delete(connectionId)
    this.queuedApplicationMessages.delete(transportPeerId)
    this.channelRegistry.cancelForConnection(connectionId)
    const wasVerified = this.verifiedConnectionIds.delete(connectionId)

    if (notify && (wasVerified || connectionId)) {
      this.options.onPeerLeave?.(connectionId)
    }
  }

  private async flushQueuedApplicationMessages(
    generation: number,
    transportPeerId: string,
    connectionId: string,
  ) {
    const queued = this.queuedApplicationMessages.get(transportPeerId)
    this.queuedApplicationMessages.delete(transportPeerId)
    if (!queued?.length || !this.currentGeneration(generation)) return
    for (const message of queued) {
      if (!this.currentGeneration(generation)) return
      await this.channelRegistry.handleIncoming(generation, message.envelope, connectionId)
    }
  }

  private queueApplicationMessage(
    transportPeerId: string,
    envelope: PartyChannelEnvelope,
    connectionId: string,
  ) {
    const queue = this.queuedApplicationMessages.get(transportPeerId) ?? []
    if (queue.length >= MAX_QUEUED_APPLICATION_MESSAGES_PER_PEER) queue.shift()
    queue.push({ envelope, connectionId })
    this.queuedApplicationMessages.set(transportPeerId, queue)
  }

  private async handleTransportHandshake(
    generation: number,
    transportPeerId: string,
    send: PartyTransportHandshakeSend,
    receive: PartyTransportHandshakeReceive,
    isInitiator: boolean,
  ) {
    if (!this.currentGeneration(generation)) {
      throw new Error('Party transport generation is no longer active')
    }
    const connectionId = this.getOrCreateConnectionId(transportPeerId)
    await this.options.handshake?.({ connectionId, send, receive, isInitiator })
    if (!this.currentGeneration(generation)) {
      throw new Error('Party transport generation is no longer active')
    }
  }

  private handleApplicationMessage(generation: number, data: string, transportPeerId: string) {
    if (!this.currentGeneration(generation)) return
    const envelope = this.channelRegistry.prepareIncoming(data)
    if (!envelope) return
    const connectionId = this.getOrCreateConnectionId(transportPeerId)
    if (!this.verifiedConnectionIds.has(connectionId)) {
      this.queueApplicationMessage(transportPeerId, envelope, connectionId)
      return
    }
    void this.channelRegistry.handleIncoming(generation, envelope, connectionId)
  }

  private async handleControlMessage(generation: number, data: string, transportPeerId: string) {
    if (!this.currentGeneration(generation)) return
    const message = parseControlMessage(data)
    if (!message) return

    if (message.type === 'probe') {
      try {
        await this.transport?.sendControl(
          serializeControlMessage({
            version: PARTY_CONTROL_VERSION,
            type: 'ack',
            requestId: message.requestId,
            generation: message.generation,
          }),
          transportPeerId,
        )
      } catch {
        // A failed acknowledgement will be observed by the remote probe timeout.
      }
      return
    }

    const pending = this.pendingProbes.get(message.requestId)
    if (
      !pending ||
      pending.generation !== message.generation ||
      pending.generation !== this.generation ||
      pending.transportPeerId !== transportPeerId
    ) {
      return
    }

    clearTimeout(pending.timer)
    this.pendingProbes.delete(message.requestId)
    pending.resolve(true)
  }

  private probeTransportPeer(transportPeerId: string) {
    if (!this.transport || this.disposed) return Promise.resolve(false)

    const generation = this.generation
    const requestId = `probe_${generation}_${++this.nextProbeSequence}`

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingProbes.get(requestId)
        if (!pending) return
        this.pendingProbes.delete(requestId)
        resolve(false)
      }, this.probeTimeoutMs)

      this.pendingProbes.set(requestId, {
        generation,
        transportPeerId,
        resolve,
        timer,
      })

      void this.transport!.sendControl(
        serializeControlMessage({
          version: PARTY_CONTROL_VERSION,
          type: 'probe',
          requestId,
          generation,
        }),
        transportPeerId,
      ).catch(() => {
        const pending = this.pendingProbes.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingProbes.delete(requestId)
        resolve(false)
      })
    })
  }

  private async verifyAndExposePeer(generation: number, transportPeerId: string) {
    if (!this.currentGeneration(generation)) return
    const connectionId = this.getOrCreateConnectionId(transportPeerId)
    if (this.verifiedConnectionIds.has(connectionId)) return

    const confirmed = await this.probeTransportPeer(transportPeerId)
    if (!this.currentGeneration(generation)) return

    if (!confirmed) {
      this.removeConnection(transportPeerId, true)
      const hasVerifiedPeer = this.verifiedConnectionIds.size > 0
      if (hasVerifiedPeer) this.transport?.disconnectPeer(transportPeerId)
      this.emitSnapshot(hasVerifiedPeer ? 'online' : 'interrupted')
      return
    }

    this.verifiedConnectionIds.add(connectionId)
    this.emitSnapshot('online')
    await this.flushQueuedApplicationMessages(generation, transportPeerId, connectionId)
    if (!this.currentGeneration(generation)) return
    this.options.onPeerJoin?.(connectionId)
  }

  private handlePeerLeave(generation: number, transportPeerId: string) {
    if (!this.currentGeneration(generation)) return
    this.removeConnection(transportPeerId, true)
    this.emitSnapshot(this.verifiedConnectionIds.size ? 'online' : 'interrupted')
  }

  private handleJoinError(generation: number, details: { error: string; peerId: string }) {
    if (!this.currentGeneration(generation)) return
    this.options.onJoinError?.({
      error: details.error,
      connectionId: this.connectionId(details.peerId),
    })
  }

  private createHandlers(generation: number): PartyTransportHandlers {
    return {
      onMessage: (data, peerId) => this.handleApplicationMessage(generation, data, peerId),
      onControlMessage: (data, peerId) => this.handleControlMessage(generation, data, peerId),
      onPeerJoin: (peerId) => {
        void this.verifyAndExposePeer(generation, peerId)
      },
      onPeerLeave: (peerId) => this.handlePeerLeave(generation, peerId),
      onJoinError: (details) => this.handleJoinError(generation, details),
      onPeerHandshake: (peerId, send, receive, isInitiator) =>
        this.handleTransportHandshake(generation, peerId, send, receive, isInitiator),
    }
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('Party client is closed'))
    if (this.startPromise) return this.startPromise
    if (this.transport) return Promise.resolve()

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal() {
    const generation = ++this.generation
    this.emitSnapshot('connecting')
    const transport = this.options.createTransport(this.createHandlers(generation))
    this.transport = transport

    try {
      await transport.start()
    } catch (error) {
      if (this.currentGeneration(generation)) {
        this.emitSnapshot(
          'error',
          error instanceof Error ? error.message : 'Party transport failed',
        )
      }
      throw error
    }
  }

  channel<T>(definition: PartyChannelDefinition<T>): PartyChannel<T> {
    return this.channelRegistry.channel(definition)
  }

  peerIds() {
    return [...this.verifiedConnectionIds]
  }

  private async sendApplicationEnvelope(data: string, target?: string | readonly string[] | null) {
    const transport = this.transport
    if (!transport || this.disposed) throw new Error('Party client is not active')

    let connectionIds: string[]
    if (typeof target === 'string') connectionIds = [target]
    else if (Array.isArray(target)) connectionIds = [...target]
    else connectionIds = [...this.verifiedConnectionIds]

    if (!connectionIds.length) throw new Error('Party client has no verified peer target')

    const transportTargets = connectionIds.map((connectionId) => {
      if (!this.verifiedConnectionIds.has(connectionId)) {
        throw new Error('Party connection is not verified')
      }
      const transportPeerId = this.transportPeerId(connectionId)
      if (!transportPeerId) throw new Error('Party connection is no longer active')
      return transportPeerId
    })

    await transport.send(
      data,
      transportTargets.length === 1 ? transportTargets[0] : transportTargets,
    )
  }

  disconnectPeer(connectionId: string) {
    const transportPeerId = this.transportPeerId(connectionId)
    if (!transportPeerId) return
    this.transport?.disconnectPeer(transportPeerId)
  }

  async revalidate() {
    if (
      this.disposed ||
      this.snapshot.state === 'reload-required' ||
      this.snapshot.state === 'closed' ||
      this.snapshot.state === 'error'
    ) {
      return false
    }

    const generation = this.generation
    const peers = [...this.verifiedConnectionIds]
    if (!peers.length) {
      this.emitSnapshot('interrupted')
      return false
    }

    this.emitSnapshot('recovering')
    const results = await Promise.all(
      peers.map(async (connectionId) => {
        const transportPeerId = this.transportPeerId(connectionId)
        if (!transportPeerId) return { connectionId, transportPeerId: null, confirmed: false }
        return {
          connectionId,
          transportPeerId,
          confirmed: await this.probeTransportPeer(transportPeerId),
        }
      }),
    )

    if (!this.currentGeneration(generation)) return false

    const confirmed = results.some((result) => result.confirmed)
    for (const result of results) {
      if (result.confirmed || !result.transportPeerId) continue
      this.removeConnection(result.transportPeerId, true)
      if (confirmed) this.transport?.disconnectPeer(result.transportPeerId)
    }

    this.emitSnapshot(confirmed ? 'online' : 'interrupted')
    return confirmed
  }

  private recoverTransport() {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.recoverTransportInternal().finally(() => {
      this.recoveryPromise = null
    })
    return this.recoveryPromise
  }

  private async recoverTransportInternal() {
    if (
      this.disposed ||
      this.snapshot.state === 'reload-required' ||
      this.snapshot.state === 'closed' ||
      this.snapshot.state === 'error'
    ) {
      return false
    }

    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        return false
      }
    }

    if (this.disposed) return false
    const transport = this.transport
    if (!transport) return false

    this.clearRecoveryDeadline()
    const previousGeneration = this.generation
    const generation = ++this.generation
    this.channelRegistry.cancelForGeneration(previousGeneration)
    this.clearConnections(true)
    this.emitSnapshot('recovering')

    let teardownResult: { requiresReload: boolean }
    try {
      teardownResult = await transport.dispose()
    } catch {
      teardownResult = { requiresReload: true }
    }

    if (this.disposed || generation !== this.generation) return false
    if (this.transport === transport) this.transport = null

    if (teardownResult.requiresReload) {
      this.requireReload()
      return false
    }

    try {
      const nextTransport = this.options.createTransport(this.createHandlers(generation))
      this.transport = nextTransport
      await nextTransport.start()
      if (!this.currentGeneration(generation)) return false
      if (this.snapshot.state === 'recovering') this.armRecoveryDeadline(generation)
      return true
    } catch (error) {
      if (this.currentGeneration(generation)) {
        this.emitSnapshot(
          'error',
          error instanceof Error ? error.message : 'Party transport recovery failed',
        )
      }
      return false
    }
  }

  private requireReload() {
    if (this.disposed || this.snapshot.state === 'reload-required') return
    this.emitSnapshot('reload-required')
    try {
      this.options.onReloadRequired?.()
    } catch {
      // Consumer recovery policy must not affect package state.
    }
  }

  private async handleLifecycleSignal() {
    if (this.disposed) return

    if (this.snapshot.state === 'online') {
      if (await this.revalidate()) return
      await this.recoverTransport()
      return
    }

    if (this.snapshot.state === 'interrupted') {
      await this.recoverTransport()
    }
  }

  dispose() {
    if (!this.disposePromise) {
      this.disposed = true
      this.lifecycleUnsubscribe?.()
      this.lifecycleUnsubscribe = null
      this.disposePromise = this.disposeInternal()
    }
    return this.disposePromise
  }

  private async disposeInternal() {
    this.clearRecoveryDeadline()
    this.cancelAllProbes()
    this.channelRegistry.dispose()

    const transport = this.transport
    this.transport = null
    let result = { requiresReload: false }
    if (transport) {
      try {
        result = await transport.dispose()
      } catch {
        result = { requiresReload: true }
      }
    }

    this.verifiedConnectionIds.clear()
    this.connectionIdByTransportPeer.clear()
    this.transportPeerByConnectionId.clear()
    this.queuedApplicationMessages.clear()
    this.emitSnapshot(result.requiresReload ? 'reload-required' : 'closed')
    this.subscribers.clear()
    return result
  }
}
