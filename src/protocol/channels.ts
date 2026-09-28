const encoder = new TextEncoder()

export const PARTY_CHANNEL_ENVELOPE_VERSION = 1
export const MAX_PARTY_CHANNEL_ID_LENGTH = 64
export const MAX_PARTY_CHANNEL_PAYLOAD_BYTES = 2 * 1024 * 1024
// Payloads are JSON-string encoded inside the package envelope. In the worst case,
// JSON escaping can expand one payload byte to six ASCII bytes (for example U+0000).
// Keep a hard pre-parse envelope bound while still permitting the documented payload ceiling.
export const MAX_PARTY_CHANNEL_ENVELOPE_BYTES = MAX_PARTY_CHANNEL_PAYLOAD_BYTES * 6 + 512
export const DEFAULT_PARTY_REQUEST_TIMEOUT_MS = 5_000
export const MAX_PARTY_REQUEST_TIMEOUT_MS = 60_000

export const PARTY_CHANNEL_CAPABILITIES = Object.freeze({
  targetedSend: true,
  broadcast: true,
  requestResponse: true,
})

export type PartyChannelCapabilities = typeof PARTY_CHANNEL_CAPABILITIES

export type PartyChannelDefinition<T> = {
  id: string
  maxPayloadBytes: number
  serialize(payload: T): string
  parse(serialized: string): T | null
}

export type PartyChannelMessage<T> = Readonly<{
  payload: T
  sourceConnectionId: string
}>

export type PartyChannelSendOptions = Readonly<{
  to?: string | readonly string[] | null
}>

export type PartyChannelRequestOptions = Readonly<{
  to: string
  timeoutMs?: number
}>

export type PartyChannelRequestHandler<T> = (
  request: PartyChannelMessage<T>,
) => T | undefined | Promise<T | undefined>

export interface PartyChannel<T> {
  readonly id: string
  readonly maxPayloadBytes: number
  readonly capabilities: PartyChannelCapabilities
  send(payload: T, options?: PartyChannelSendOptions): Promise<void>
  request(payload: T, options: PartyChannelRequestOptions): Promise<PartyChannelMessage<T>>
  subscribe(listener: (message: PartyChannelMessage<T>) => void | Promise<void>): () => void
  onRequest(handler: PartyChannelRequestHandler<T>): () => void
}

export type PartyChannelEnvelope =
  | Readonly<{
      version: 1
      type: 'message'
      channel: string
      payload: string
    }>
  | Readonly<{
      version: 1
      type: 'request'
      channel: string
      requestId: string
      payload: string
    }>
  | Readonly<{
      version: 1
      type: 'response'
      channel: string
      requestId: string
      payload: string
    }>

type PartyChannelRuntime = {
  generation(): number
  isGenerationActive(generation: number): boolean
  isConnectionActive(connectionId: string): boolean
  send(serialized: string, target?: string | readonly string[] | null): Promise<void>
}

type ChannelRegistration = {
  id: string
  maxPayloadBytes: number
  serialize(payload: unknown): string
  parse(serialized: string): unknown | null
  subscribers: Set<(message: PartyChannelMessage<unknown>) => void | Promise<void>>
  requestHandler: PartyChannelRequestHandler<unknown> | null
}

type PendingRequest = {
  generation: number
  channel: string
  targetConnectionId: string
  resolve: (message: PartyChannelMessage<unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(record)
  return keys.length === expected.length && expected.every((key) => key in record)
}

function isChannelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PARTY_CHANNEL_ID_LENGTH &&
    /^[a-z][a-z0-9-]*$/u.test(value)
  )
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^request_[1-9][0-9]*_[1-9][0-9]*$/u.test(value)
  )
}

export function parsePartyChannelEnvelope(serialized: string): PartyChannelEnvelope | null {
  if (utf8ByteLength(serialized) > MAX_PARTY_CHANNEL_ENVELOPE_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return null
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== PARTY_CHANNEL_ENVELOPE_VERSION ||
    !isChannelId(parsed.channel) ||
    typeof parsed.payload !== 'string'
  ) {
    return null
  }

  if (parsed.type === 'message') {
    if (!hasExactKeys(parsed, ['version', 'type', 'channel', 'payload'])) return null
    return Object.freeze({
      version: PARTY_CHANNEL_ENVELOPE_VERSION,
      type: 'message',
      channel: parsed.channel,
      payload: parsed.payload,
    })
  }

  if (parsed.type === 'request' || parsed.type === 'response') {
    if (
      !hasExactKeys(parsed, ['version', 'type', 'channel', 'requestId', 'payload']) ||
      !isRequestId(parsed.requestId)
    ) {
      return null
    }
    return Object.freeze({
      version: PARTY_CHANNEL_ENVELOPE_VERSION,
      type: parsed.type,
      channel: parsed.channel,
      requestId: parsed.requestId,
      payload: parsed.payload,
    })
  }

  return null
}

function serializeEnvelope(envelope: PartyChannelEnvelope) {
  const serialized = JSON.stringify(envelope)
  if (utf8ByteLength(serialized) > MAX_PARTY_CHANNEL_ENVELOPE_BYTES) {
    throw new Error('Party channel envelope exceeds the package byte limit')
  }
  return serialized
}

function requestTimeout(timeoutMs: number | undefined) {
  const timeout = timeoutMs ?? DEFAULT_PARTY_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_PARTY_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `Party request timeout must be greater than zero and at most ${MAX_PARTY_REQUEST_TIMEOUT_MS}ms`,
    )
  }
  return timeout
}

export class PartyChannelRegistry {
  private readonly runtime: PartyChannelRuntime
  private readonly channels = new Map<string, ChannelRegistration>()
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private nextRequestSequence = 0
  private disposed = false

  constructor(runtime: PartyChannelRuntime) {
    this.runtime = runtime
  }

  channel<T>(definition: PartyChannelDefinition<T>): PartyChannel<T> {
    if (this.disposed) throw new Error('Party channel registry is closed')
    if (!isChannelId(definition.id)) {
      throw new Error(
        `Party channel ID must match /^[a-z][a-z0-9-]*$/ and be at most ${MAX_PARTY_CHANNEL_ID_LENGTH} characters`,
      )
    }
    if (
      !Number.isSafeInteger(definition.maxPayloadBytes) ||
      definition.maxPayloadBytes <= 0 ||
      definition.maxPayloadBytes > MAX_PARTY_CHANNEL_PAYLOAD_BYTES
    ) {
      throw new Error(
        `Party channel maxPayloadBytes must be an integer between 1 and ${MAX_PARTY_CHANNEL_PAYLOAD_BYTES}`,
      )
    }
    if (this.channels.has(definition.id)) {
      throw new Error(`Party channel "${definition.id}" is already registered`)
    }

    const registration: ChannelRegistration = {
      id: definition.id,
      maxPayloadBytes: definition.maxPayloadBytes,
      serialize: (payload) => definition.serialize(payload as T),
      parse: (serialized) => definition.parse(serialized),
      subscribers: new Set(),
      requestHandler: null,
    }
    this.channels.set(definition.id, registration)

    return Object.freeze({
      id: definition.id,
      maxPayloadBytes: definition.maxPayloadBytes,
      capabilities: PARTY_CHANNEL_CAPABILITIES,
      send: (payload: T, options?: PartyChannelSendOptions) =>
        this.send(registration, payload, options?.to),
      request: (payload: T, options: PartyChannelRequestOptions) =>
        this.request(registration, payload, options),
      subscribe: (listener: (message: PartyChannelMessage<T>) => void | Promise<void>) => {
        const wrapped = listener as (message: PartyChannelMessage<unknown>) => void | Promise<void>
        registration.subscribers.add(wrapped)
        return () => registration.subscribers.delete(wrapped)
      },
      onRequest: (handler: PartyChannelRequestHandler<T>) => {
        if (registration.requestHandler) {
          throw new Error(`Party channel "${registration.id}" already has a request handler`)
        }
        const wrapped = handler as PartyChannelRequestHandler<unknown>
        registration.requestHandler = wrapped
        return () => {
          if (registration.requestHandler === wrapped) registration.requestHandler = null
        }
      },
    })
  }

  prepareIncoming(serialized: string) {
    if (this.disposed) return null
    const envelope = parsePartyChannelEnvelope(serialized)
    if (!envelope) return null
    const registration = this.channels.get(envelope.channel)
    if (!registration) return null
    if (utf8ByteLength(envelope.payload) > registration.maxPayloadBytes) return null
    return envelope
  }

  async handleIncoming(
    generation: number,
    envelope: PartyChannelEnvelope,
    sourceConnectionId: string,
  ) {
    if (
      this.disposed ||
      !this.runtime.isGenerationActive(generation) ||
      !this.runtime.isConnectionActive(sourceConnectionId)
    ) {
      return
    }

    const registration = this.channels.get(envelope.channel)
    if (!registration || utf8ByteLength(envelope.payload) > registration.maxPayloadBytes) return

    if (envelope.type === 'response') {
      this.handleResponse(generation, registration, envelope, sourceConnectionId)
      return
    }

    const payload = this.parsePayload(registration, envelope.payload)
    if (payload === null) return
    const message = Object.freeze({
      payload,
      sourceConnectionId,
    }) satisfies PartyChannelMessage<unknown>

    if (envelope.type === 'message') {
      for (const subscriber of [...registration.subscribers]) {
        try {
          await subscriber(message)
        } catch {
          // Consumer handlers must not affect package transport state.
        }
      }
      return
    }

    const handler = registration.requestHandler
    if (!handler) return

    let response: unknown | undefined
    try {
      response = await handler(message)
    } catch {
      return
    }
    if (
      response === undefined ||
      this.disposed ||
      !this.runtime.isGenerationActive(generation) ||
      !this.runtime.isConnectionActive(sourceConnectionId)
    ) {
      return
    }

    try {
      const serializedResponse = this.serializePayload(registration, response)
      await this.runtime.send(
        serializeEnvelope({
          version: PARTY_CHANNEL_ENVELOPE_VERSION,
          type: 'response',
          channel: registration.id,
          requestId: envelope.requestId,
          payload: serializedResponse,
        }),
        sourceConnectionId,
      )
    } catch {
      // Invalid consumer responses fail closed. The requester observes its bounded timeout.
    }
  }

  cancelForConnection(connectionId: string) {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.targetConnectionId !== connectionId) continue
      this.rejectPending(requestId, pending, 'Party request target disconnected')
    }
  }

  cancelForGeneration(generation: number) {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.generation !== generation) continue
      this.rejectPending(requestId, pending, 'Party request transport generation ended')
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.rejectPending(requestId, pending, 'Party client is closed')
    }
    for (const registration of this.channels.values()) {
      registration.subscribers.clear()
      registration.requestHandler = null
    }
    this.channels.clear()
  }

  private async send(
    registration: ChannelRegistration,
    payload: unknown,
    target?: string | readonly string[] | null,
  ) {
    if (this.disposed) throw new Error('Party channel registry is closed')
    const serializedPayload = this.serializePayload(registration, payload)
    await this.runtime.send(
      serializeEnvelope({
        version: PARTY_CHANNEL_ENVELOPE_VERSION,
        type: 'message',
        channel: registration.id,
        payload: serializedPayload,
      }),
      target,
    )
  }

  private request<T>(
    registration: ChannelRegistration,
    payload: T,
    options: PartyChannelRequestOptions,
  ): Promise<PartyChannelMessage<T>> {
    if (this.disposed) return Promise.reject(new Error('Party channel registry is closed'))
    if (!options.to) return Promise.reject(new Error('Party request requires a target connection'))

    let timeoutMs: number
    let serializedPayload: string
    try {
      timeoutMs = requestTimeout(options.timeoutMs)
      serializedPayload = this.serializePayload(registration, payload)
    } catch (error) {
      return Promise.reject(error)
    }

    const generation = this.runtime.generation()
    const requestId = `request_${generation}_${++this.nextRequestSequence}`
    const serializedEnvelope = serializeEnvelope({
      version: PARTY_CHANNEL_ENVELOPE_VERSION,
      type: 'request',
      channel: registration.id,
      requestId,
      payload: serializedPayload,
    })

    return new Promise<PartyChannelMessage<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) return
        this.pendingRequests.delete(requestId)
        reject(new Error(`Party request timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        generation,
        channel: registration.id,
        targetConnectionId: options.to,
        resolve: resolve as (message: PartyChannelMessage<unknown>) => void,
        reject,
        timer,
      })

      void this.runtime.send(serializedEnvelope, options.to).catch((error) => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error('Party request send failed'))
      })
    })
  }

  private handleResponse(
    generation: number,
    registration: ChannelRegistration,
    envelope: Extract<PartyChannelEnvelope, { type: 'response' }>,
    sourceConnectionId: string,
  ) {
    const pending = this.pendingRequests.get(envelope.requestId)
    if (
      !pending ||
      pending.generation !== generation ||
      pending.generation !== this.runtime.generation() ||
      pending.channel !== registration.id ||
      pending.targetConnectionId !== sourceConnectionId
    ) {
      return
    }

    const payload = this.parsePayload(registration, envelope.payload)
    clearTimeout(pending.timer)
    this.pendingRequests.delete(envelope.requestId)

    if (payload === null) {
      pending.reject(new Error('Party response payload was invalid'))
      return
    }

    pending.resolve(
      Object.freeze({
        payload,
        sourceConnectionId,
      }),
    )
  }

  private serializePayload(registration: ChannelRegistration, payload: unknown) {
    const serialized = registration.serialize(payload)
    if (typeof serialized !== 'string') {
      throw new Error(`Party channel "${registration.id}" serializer must return a string`)
    }
    if (utf8ByteLength(serialized) > registration.maxPayloadBytes) {
      throw new Error(`Party channel "${registration.id}" payload exceeds its byte limit`)
    }
    return serialized
  }

  private parsePayload(registration: ChannelRegistration, serialized: string) {
    if (utf8ByteLength(serialized) > registration.maxPayloadBytes) return null
    try {
      return registration.parse(serialized)
    } catch {
      return null
    }
  }

  private rejectPending(requestId: string, pending: PendingRequest, message: string) {
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    pending.reject(new Error(message))
  }
}
