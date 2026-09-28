# Security

## Supported versions

Until the API reaches 1.0, security fixes are applied to the latest published 0.x line.

## Reporting

Do not post credentials, capabilities, private room identifiers, raw SDP/candidates, IP addresses, or exploit details in a public issue.

Use GitHub private vulnerability reporting when the repository presents that option. If private reporting is unavailable, open a minimal public issue requesting a private maintainer contact path without including sensitive details.

## Consumer responsibilities

Party establishes generic browser connectivity and validates package-owned envelopes. Consumers remain responsible for authenticating peers where required, authorizing application actions, validating application payloads, protecting durable credentials, and deciding what state is authoritative.

A Party connection ID is ephemeral connection metadata, not an authenticated durable user identity.
