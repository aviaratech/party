import { describe, expect, it, vi } from 'vitest'
import {
  TrysteroNostrTransport,
  type TrysteroNostrModuleLike,
  type TrysteroRoomLike,
} from './trysteroNostrTransport.js'

function createRoom(): TrysteroRoomLike {
  const action = {
    send: vi.fn(async () => undefined),
    onMessage: null as ((data: string, context: { peerId: string }) => void | Promise<void>) | null,
  }
  return {
    makeAction: vi.fn(() => action),
    leave: vi.fn(async () => undefined),
    isPassive: vi.fn(() => false),
    getPeers: vi.fn(() => ({})),
    onPeerJoin: null,
    onPeerLeave: null,
  }
}

describe('TrysteroNostrTransport offer-pool containment', () => {
  it('preserves an unanswered pooled offer when Trystero attempts an aged ICE restart', async () => {
    let suppliedRtcPolyfill:
      | (new (configuration?: RTCConfiguration) => RTCPeerConnection)
      | undefined
    const nativeRestartIce = vi.fn()
    const nativeCreateOffer = vi.fn()
    const nativeSetLocalDescription = vi.fn()

    class FakeRtcPeerConnection {
      localDescription: RTCSessionDescription | null = null
      remoteDescription: RTCSessionDescription | null = null
      iceGatheringState: RTCIceGatheringState = 'complete'
      iceConnectionState: RTCIceConnectionState = 'new'
      connectionState: RTCPeerConnectionState = 'new'

      readonly addEventListener = vi.fn()
      readonly addIceCandidate = vi.fn(async () => undefined)

      restartIce() {
        nativeRestartIce()
      }

      async createOffer(options?: RTCOfferOptions) {
        nativeCreateOffer(options)
        return {
          type: 'offer' as RTCSdpType,
          sdp: options?.iceRestart
            ? 'v=0\r\n'
            : 'v=0\r\na=candidate:1 1 UDP 1 0.0.0.0 9 typ host\r\n',
        }
      }

      async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
        nativeSetLocalDescription(description)
        if (!description) return
        if (description.type === 'rollback') {
          this.localDescription = null
          return
        }
        const snapshot = { type: description.type, sdp: description.sdp ?? '' }
        this.localDescription = {
          ...snapshot,
          toJSON: () => ({ ...snapshot }),
        } as RTCSessionDescription
      }

      readonly getStats = vi.fn(async () => new Map())
    }

    const room = createRoom()
    const module: TrysteroNostrModuleLike = {
      joinRoom: vi.fn((config) => {
        suppliedRtcPolyfill = config.rtcPolyfill
        return room
      }),
    }

    const transport = new TrysteroNostrTransport({
      role: 'host',
      appId: 'party-test',
      actionNamespace: 'party-test-action',
      wakeNamespace: 'PartyTestWake',
      relayUrls: ['wss://relay.example'],
      partyId: 'party-a',
      rendezvousCapability: 'rendezvous-a',
      rtcPeerConnection: FakeRtcPeerConnection as unknown as new (
        configuration?: RTCConfiguration,
      ) => RTCPeerConnection,
      loadModule: async () => module,
      poisonRegistry: new Set(),
    })

    await transport.start()
    expect(suppliedRtcPolyfill).toBeDefined()

    const peer = new suppliedRtcPolyfill!()
    const initialOffer = await peer.createOffer()
    await peer.setLocalDescription(initialOffer)

    expect(peer.localDescription?.sdp).toContain('a=candidate')

    await peer.setLocalDescription({ type: 'rollback' })
    peer.restartIce()
    const refreshedOffer = await peer.createOffer({ iceRestart: true })
    await peer.setLocalDescription(refreshedOffer)

    expect(nativeRestartIce).not.toHaveBeenCalled()
    expect(nativeCreateOffer).toHaveBeenCalledTimes(1)
    expect(nativeSetLocalDescription).toHaveBeenCalledTimes(1)
    expect(refreshedOffer.sdp).toContain('a=candidate')
    expect(peer.localDescription?.sdp).toContain('a=candidate')

    await transport.dispose()
  })
})
