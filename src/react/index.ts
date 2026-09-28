import { useCallback, useSyncExternalStore } from 'react'
import type { PartyClient, PartyClientSnapshot } from '../core/PartyClient.js'

export type PartyExternalStore = Pick<PartyClient, 'getSnapshot' | 'subscribe'>

export function useParty(party: PartyExternalStore): PartyClientSnapshot {
  const subscribe = useCallback((listener: () => void) => party.subscribe(listener), [party])
  const getSnapshot = useCallback(() => party.getSnapshot(), [party])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function usePartyStatus(party: PartyExternalStore) {
  return useParty(party).state
}

export function usePartyPeers(party: PartyExternalStore) {
  return useParty(party).peers
}
