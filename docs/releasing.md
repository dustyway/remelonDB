# Releasing

Releases publish to npm from CI via trusted publishing (OIDC): pushing a
`v*` tag runs `.github/workflows/release.yml`, which tests, builds,
packs every workspace package, and `npm publish`es each tarball whose
version matches the tag and is not already on the registry. No tokens,
no OTP; provenance attestations are automatic.

## Cutting a release

1. Bump every `package.json` (root + `packages/*`) to the new version,
   commit as `chore(release): vX.Y.Z`.
2. `git tag -s vX.Y.Z && git push && git push origin vX.Y.Z`.
3. Watch the Release workflow; then create the GitHub Release entry for
   the tag (notes, no tarball attachments — npm is the distribution).

Release tags must be **signed**: a repository ruleset rejects unsigned
`v*` tags and forbids deleting or moving them once pushed. The
repository's git config signs tags automatically (`tag.gpgSign`), so
step 2's `-s` is belt and braces.

The workflow fails loudly if any package's version disagrees with the
tag, and skips versions already published — re-running it is safe.

The publish job runs in the `npm-publish` deployment environment, which
requires an approval in the Actions UI before any step executes; the
environment name is part of each package's trusted-publisher pin, so
OIDC claims without it are rejected by npm.

## Trusted publisher configuration (one-time, per package)

On npmjs.com: package → Settings → Trusted Publisher → GitHub Actions,
with exactly:

| Field | Value |
| --- | --- |
| Organization or user | `dustyway` |
| Repository | `remelonDB` |
| Workflow filename | `release.yml` |
| Environment name | `npm-publish` |
| Allowed actions | `npm publish` |

Requirements baked into the workflow: npm ≥ 11.5.1 (upgraded in-job),
`permissions: id-token: write`.

## First-time packages

A package that has never been published cannot use trusted publishing
for its first release: publish its tarball once manually
(`pnpm --filter <pkg> pack`, then `npm publish <tarball>` in an
interactive terminal — browser auth + security key), then configure its
trusted publisher as above. Later releases are fully automated. The
workflow's already-published skip makes mixed releases safe: manual
first publishes and CI publishes can share one tag.
