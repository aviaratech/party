# Repository working agreement

This repository owns the reusable public `@aviaratech/party` package.

## Boundaries

Package-owned concerns:

- headless Party lifecycle and connection-scoped peer primitives;
- bounded generic channels/request-response;
- browser lifecycle helpers;
- transport adapters;
- privacy-safe generic networking diagnostics;
- optional framework adapters such as React.

Consumer-owned concerns:

- durable user/member/player identity;
- application authorization and payload schemas;
- persistence and canonical application state;
- matchmaking/accounts;
- Chat or game semantics;
- simulation, prediction, reconciliation, interpolation, scoring, and progression;
- product UI and product telemetry policy.

Keep React optional and off frame-critical paths. Treat remote data as untrusted. Preserve byte bounds, closed package envelopes, generation guards, and fail-closed unsafe teardown.

## Workflow

Use focused branches and pull requests. Run `npm run checks` before merge. Do not publish from feature branches. Do not publish a version unless the license/publication gates in `RELEASE.md` are satisfied.
