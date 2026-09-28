export type PartyTransportHandshakeSend = (data: string) => Promise<void>
export type PartyTransportHandshakeReceive = () => Promise<{ data: unknown; metadata?: unknown }>

export type PartyTransportHandlers = {
  onMessage?: (data: string, peerId: string) => void | Promise<void>
  onControlMessage?: (data: string, peerId: string) => void | Promise<void>
  onPeerJoin?: (peerId: string) => void
  onPeerLeave?: (peerId: string) => void
  onJoinError?: (details: { error: string; peerId: string }) => void
  onPeerHandshake?: (
    peerId: string,
    send: PartyTransportHandshakeSend,
    receive: PartyTransportHandshakeReceive,
    isInitiator: boolean,
  ) => Promise<void>
}

export interface PartyTransportClient {
  start(): Promise<void>
  send(data: string, target?: string | string[] | null): Promise<void>
  sendControl(data: string, target: string): Promise<void>
  peerIds(): string[]
  disconnectPeer(peerId: string): void
  dispose(): Promise<{ requiresReload: boolean }>
}
