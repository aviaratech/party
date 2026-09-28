# Release policy

## Versioning

Party uses semantic versioning with an explicit pre-1.0 policy:

- patch releases are backward-compatible fixes;
- minor releases may include documented breaking API changes while the package remains `0.x`;
- every published version is immutable;
- the Git tag must be exactly `v<package.json version>`;
- published versions are never overwritten.

The first intended public consumer release is `0.1.0`.

## Publication safety gates

Before any publish:

1. the approved MIT license is present in `package.json` and `LICENSE`;
2. `npm ci && npm run checks` passes from a clean checkout;
3. `npm pack --dry-run --json` contains only the intended package files;
4. the release tag matches `package.json#version`;
5. the changelog/release notes describe consumer-visible changes;
6. the repository contains no private application material or credentials;
7. an owner explicitly authorizes the release.

`prepublishOnly` verifies that an approved license remains present before publication.

## npm trusted publishing

The release workflow is `.github/workflows/release.yml`. It uses a GitHub-hosted runner with only:

- `contents: read`;
- `id-token: write`.

It does not use or require a long-lived npm write token.

After the npm package exists, configure its Trusted Publisher on npmjs.com with:

- provider: GitHub Actions;
- organization/user: `aviaratech`;
- repository: `party`;
- workflow filename: `release.yml`;
- allowed action: direct `npm publish`.

Current npm documentation requires npm 11.5.1+ and Node 22.14+ for trusted publishing. The workflow pins newer compatible versions. Publishing through trusted publishing from this public repository should receive npm provenance automatically.

Official reference: https://docs.npmjs.com/trusted-publishers/

## First-package bootstrap

npm's trusted-publisher configuration is attached to an npm package, which creates a bootstrap problem when a scoped package has never been published. npm's public documentation/community tracking should be rechecked immediately before the first release because this behavior can change.

If npm still does not allow creating the first package through OIDC:

1. do **not** add an npm write token to GitHub;
2. from an audited clean checkout, create a temporary working copy;
3. change only the temporary copy's version to `0.0.1-oidc-bootstrap.0`;
4. run the full checks and tarball audit again;
5. an Aviara Tech npm owner manually publishes that bootstrap version with public access under a non-default tag such as `bootstrap`;
6. configure the exact trusted-publisher relationship above;
7. publish the reviewed `0.1.0` release through the GitHub workflow;
8. verify npm displays provenance and the source repository link for `0.1.0`;
9. optionally deprecate the bootstrap prerelease once the trusted path is proven.

The bootstrap version is not the supported consumer release and should never become the `latest` dist-tag.

## Release workflow

After the repository PR is merged, the npm package exists, trusted publishing is configured, and the owner has explicitly approved a release:

1. update version/changelog in a focused PR if needed;
2. merge only after CI is green;
3. create tag `v<version>` from the reviewed commit;
4. publish a GitHub Release for that tag;
5. `release.yml` checks out the tag, runs the complete quality gate, verifies tag/version parity, and runs `npm publish --access public`;
6. verify the npm version, source link, and provenance before downstream consumers adopt it.

A failed release must not change any already-published version.
