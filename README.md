# @aviaratech/party

A small, headless browser networking library for peer lifecycle, bounded application channels, request/response, and an optional React adapter.

Party is designed for browser applications that want to own their own identity, authorization, persistence, and game/application protocol while reusing a tested WebRTC connection lifecycle.

## What Party owns

- headless `PartyClient` connection state and immutable external-store snapshots;
- connection-scoped opaque peer IDs;
- browser foreground/online recovery and explicit `reload-required` signaling;
- bounded, versioned application-channel envelopes;
- targeted send, broadcast, and correlated request/response;
- a Trystero/Nostr transport adapter;
- optional `useSyncExternalStore`-based React hooks.

## What Party does not own

Party is not a matchmaking service, authoritative game server, persistence layer, account system, moderation system, or game-netcode framework. Consumers remain responsible for application authorization, payload meaning, durable identity, canonical state, simulation, scoring, persistence, and UI.

## Install

```sh
npm install @aviaratech/party
```

The package is ESM-only. The core is framework-neutral. React is an optional peer dependency used only by `@aviaratech/party/react`.

## Headless quick start

```ts
import { PartyClient } from '@aviaratech/party'
import { createBrowserPartyLifecycleSource } from '@aviaratech/party/browser'
import { TrysteroNostrTransport } from '@aviaratech/party/trystero-nostr'

const party = new PartyClient({
  lifecycle: createBrowserPartyLifecycleSource(),
  createTransport: (handlers) =>
    new TrysteroNostrTransport({
      role: 'host',
      appId: 'your-app-id',
      actionNamespace: 'your-app-v1',
      wakeNamespace: 'YourAppWake',
      relayUrls: ['wss://your-nostr-relay.example'],
      partyId: 'shared-party-id',
      rendezvousCapability: 'shared-secret-capability',
      ...handlers,
    }),
})

await party.start()
```

The transport configuration is intentionally consumer-owned. Party does not ship application IDs, room IDs, credentials/capabilities, or a privileged relay list.

## Bounded channels

A channel owns a stable ID, a pre-parse byte limit, and consumer-defined serialization/validation.

```ts
type Control = { type: 'ready' } | { type: 'ping'; sentAt: number }

const control = party.channel<Control>({
  id: 'control',
  maxPayloadBytes: 1024,
  serialize: JSON.stringify,
  parse(serialized) {
    const value = JSON.parse(serialized) as unknown
    // Replace with your own strict parser/schema validation.
    return isControl(value) ? value : null
  },
})

await control.send({ type: 'ready' })

const response = await control.request(
  { type: 'ping', sentAt: Date.now() },
  { to: party.peerIds()[0]!, timeoutMs: 5000 },
)
```

Remote bytes are untrusted. Party validates its own closed/versioned envelope and enforces the byte bound before the consumer parser runs, but the consumer must validate its own payload schema and authorize each operation. Source connection identity is provided separately from payload data; do not trust an identity claim carried inside a remote payload.

## React

```tsx
import type { PartyClient } from '@aviaratech/party'
import { usePartyPeers, usePartyStatus } from '@aviaratech/party/react'

function ConnectionStatus({ party }: { party: PartyClient }) {
  const status = usePartyStatus(party)
  const peers = usePartyPeers(party)
  return <span>{status} · {peers.length} peers</span>
}
```

The React adapter only observes the headless external store. It does not own WebRTC objects, transport generations, recovery, or frame-by-frame game state.

## Connection states

- `idle` — client has not started;
- `connecting` — a transport generation is starting or no peer has completed the current bidirectional proof yet;
- `online` — at least one current-generation peer has passed the package control-path proof;
- `interrupted` — no currently verified peer remains;
- `recovering` — Party is revalidating/replacing the transport after a lifecycle signal;
- `reload-required` — the current browser/library transport namespace cannot be safely reused in-page;
- `closed` — the client was disposed;
- `error` — transport startup failed.

`online` is transport/package readiness, not application synchronization. Your protocol may require its own authenticated handshake, state sync, or readiness gate before gameplay or other authority-sensitive work begins.

## Browser lifecycle

`createBrowserPartyLifecycleSource()` observes foreground-relevant browser signals and lets the headless client coalesce recovery. Party never forces a navigation or reload. If the snapshot reaches `reload-required`, the consumer decides how to preserve local state and reload/recreate the page.

## Trystero / Nostr adapter

`@aviaratech/party/trystero-nostr` is the currently proven transport adapter. Trystero remains an implementation detail behind the Party transport contract; application code should not use Trystero peer IDs as durable player/member identity.

The current adapter uses public rendezvous plus direct WebRTC and does not configure TURN. Restrictive NAT/firewall environments can therefore fail to establish a direct path. Treat the supported connectivity envelope as evidence-driven rather than universal.

## Security and privacy model

- Treat every remote payload as untrusted.
- Use strict consumer validation and explicit authorization.
- Keep durable account/member/player identity outside Party.
- Treat party IDs, rendezvous capabilities, admission material, and similar secrets as consumer-owned credentials.
- Do not put credential material or application payloads into diagnostics.
- A connection ID is opaque and scoped to the active transport generation; it is not a durable identity.
- Unsafe transport teardown fails closed rather than silently reusing a poisoned generation.

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Browser support

Party targets modern evergreen browsers with WebRTC, WebSocket, `TextEncoder`, and standard browser lifecycle events. Safari/iOS lifecycle behavior is part of the tested design, but direct WebRTC reachability still depends on the networks between peers.

## API stability

The package starts at `0.x`. Semver is used, but before 1.0 a minor release may contain a breaking public-API change when the change is documented in release notes. Patch releases are reserved for compatible fixes.

See [RELEASE.md](RELEASE.md) for the release policy and provenance/trusted-publishing process.

## License

MIT © 2026 Aviara Tech LLC. See [LICENSE](LICENSE).

## Examples

See [examples/headless.ts](examples/headless.ts) and [examples/react.tsx](examples/react.tsx).
