import { PartyClient } from '@aviaratech/party'
import { createBrowserPartyLifecycleSource } from '@aviaratech/party/browser'
import { TrysteroNostrTransport } from '@aviaratech/party/trystero-nostr'

type ControlMessage = { type: 'ready' } | { type: 'ping'; sentAt: number }

function parseControlMessage(serialized: string): ControlMessage | null {
  try {
    const value = JSON.parse(serialized) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.type === 'ready') return { type: 'ready' }
    if (record.type === 'ping' && typeof record.sentAt === 'number') {
      return { type: 'ping', sentAt: record.sentAt }
    }
    return null
  } catch {
    return null
  }
}

export function createParty(role: 'host' | 'guest') {
  const party = new PartyClient({
    lifecycle: createBrowserPartyLifecycleSource(),
    createTransport: (handlers) =>
      new TrysteroNostrTransport({
        role,
        appId: 'your-app-id',
        actionNamespace: 'your-app-v1',
        wakeNamespace: 'YourAppWake',
        relayUrls: ['wss://your-nostr-relay.example'],
        partyId: 'shared-party-id',
        rendezvousCapability: 'shared-secret-capability',
        ...handlers,
      }),
  })

  const control = party.channel<ControlMessage>({
    id: 'control',
    maxPayloadBytes: 1_024,
    serialize: JSON.stringify,
    parse: parseControlMessage,
  })

  return { party, control }
}
