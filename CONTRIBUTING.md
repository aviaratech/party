# Contributing

## Development

Requirements:

- Node 24.21.x or a newer Node 24 release supported by the repository toolchain;
- npm 11.19.x.

Install and run the complete gate:

```sh
npm ci
npm run checks
```

## Design boundaries

Keep the core framework-neutral. React belongs only in the optional React subpath. Transport-specific behavior belongs in transport adapters. Do not add application identity, matchmaking, persistence, game simulation/netcode, moderation, analytics-vendor APIs, or arbitrary unbounded event payloads to the core.

Remote bytes are untrusted. New protocol surface must retain bounded pre-parse input, closed package envelopes, current-generation guards, and source identity supplied by the transport rather than payload claims.

New abstractions should be justified by real consumers rather than speculative future use.

## Pull requests

Keep changes focused, include tests for behavior changes, and keep `npm run checks` green. Browser/network lifecycle changes also need relevant real-browser validation before release.
