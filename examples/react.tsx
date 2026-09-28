import type { PartyClient } from '@aviaratech/party'
import { usePartyPeers, usePartyStatus } from '@aviaratech/party/react'

export function PartyStatus({ party }: { party: PartyClient }) {
  const status = usePartyStatus(party)
  const peers = usePartyPeers(party)

  return (
    <output>
      {status} · {peers.length} peer{peers.length === 1 ? '' : 's'}
    </output>
  )
}
