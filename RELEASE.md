# Release policy

## Versioning

Party uses semantic versioning with an explicit pre-1.0 policy:

- patch releases are backward-compatible fixes;
- minor releases may include documented breaking API changes while the package remains `0.x`;
- every published version is immutable;
- published versions are never overwritten.

The first intended public consumer release is `0.1.0`.

## Publication safety gates

Before any publish:

1. the approved MIT license is present in `package.json` and `LICENSE`;
2. `npm ci && npm run checks` passes from a clean checkout;
3. `npm pack --dry-run --json` contains only the intended package files;
4. the changelog/release notes describe consumer-visible changes;
5. the repository contains no private application material or credentials;
6. an owner explicitly authorizes the release.

`prepublishOnly` verifies that an approved license remains present before publication.

## npm trusted publishing

Party follows the same single-package publication pattern as `@aviaratech/ai-delivery`.

The release workflow is `.github/workflows/release.yml` and is **manually dispatched from protected `main`**. It does not publish in response to a tag or GitHub Release event.

The workflow:

1. refuses to package unless it is running in `aviaratech/party` on protected `main`;
2. checks package name/license/repository metadata;
3. performs a clean install and the complete quality gate;
4. packs one npm tarball, records its SHA-256, and scans source history for secrets;
5. uploads that verified tarball as a one-day GitHub Actions artifact;
6. enters the protected `npm-publish` GitHub Environment;
7. downloads and verifies the exact artifact;
8. unpacks/re-packs it with scripts disabled and requires byte-for-byte equality;
9. publishes with npm Trusted Publishing using GitHub OIDC.

The workflow uses no long-lived npm write token. The publish job has only:

- `contents: read`;
- `id-token: write`.

Configure npm Trusted Publishing for:

- provider: GitHub Actions;
- organization/user: `aviaratech`;
- repository: `party`;
- workflow filename: `release.yml`;
- environment name: `npm-publish`.

Current npm documentation requires npm 11.5.1+ and Node 22.14+ for trusted publishing. The workflow pins Node 24.21.0 and npm 11.19.0.

Official reference: https://docs.npmjs.com/trusted-publishers/

## Repository release controls

Mirror the `ai-delivery` repository controls before enabling publication:

- protect `main`;
- require CI checks named `checks` and `secrets`;
- create an `npm-publish` GitHub Environment with the intended required reviewer/approval policy;
- do not enable or invoke the release workflow until the npm package/trusted-publisher prerequisites are satisfied.

The workflow itself additionally requires `github.ref_protected`, so an unprotected `main` cannot publish.

## First-package bootstrap

npm currently requires a package to exist before a Trusted Publisher can be configured. This is the same one-time bootstrap boundary faced by a new Aviara Tech package.

To preserve `0.1.0` as the first supported OIDC/provenance release:

1. do **not** add an npm write token to GitHub;
2. from an audited clean checkout of reviewed source, create a temporary working copy;
3. change only the temporary copy's version to `0.0.1-oidc-bootstrap.0`;
4. run the complete checks and tarball audit again;
5. an Aviara Tech npm owner publishes that bootstrap prerelease interactively with 2FA, public access, and a non-default `bootstrap` dist-tag;
6. configure the exact Trusted Publisher relationship above;
7. use the normal protected-`main` workflow to publish reviewed `0.1.0`;
8. verify automatic provenance and the repository link on npm;
9. optionally deprecate the bootstrap prerelease after the trusted path is proven.

The bootstrap version is package-creation plumbing, not a supported consumer release, and must never become the `latest` dist-tag.

## Release workflow

After the repository controls above are active, the npm package exists, Trusted Publishing is configured, and the owner has explicitly approved a release:

1. update version/changelog in a focused PR if needed;
2. merge only after CI is green;
3. confirm the reviewed version on protected `main`;
4. manually dispatch **Publish npm package** from `main`;
5. approve the `npm-publish` Environment deployment when GitHub requests it;
6. let the workflow package, secret-scan, checksum, re-pack/compare, and publish the exact reviewed artifact;
7. verify the npm version, repository link, provenance, and a fresh registry-installed consumer before downstream adoption.

Published versions are immutable. A failed release must not mutate or overwrite an existing npm version.
