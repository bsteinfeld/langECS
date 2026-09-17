# Releasing

All seven `packages/*` ship together under one version as one tested release. Satellites
declare core as a `workspace:^` peer, which publishes as a caret range. For a 0.2.0
release that accepts core 0.2.x; upgrade the related packages together across 0.x minor
versions. The workspace also uses `workspace:*` dev dependencies for local builds.

After building, `pnpm check:packaging` checks every packed manifest and installs an
isolated consumer with a newer core patch version. It verifies shared component identity
and a snapshot round-trip without changing the working manifests or publishing anything.
The check needs `npm` and `tar`; its consumer install is offline and disables scripts.

| | |
|---|---|
| Registry | [npmjs.com](https://www.npmjs.com), scope `@langecs` |
| Auth | Trusted publishing (OIDC) from GitHub Actions — no long-lived token in this repo |
| Trigger | pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml) |
| Published | `@langecs/core`, `stdlib`, `ai-sdk`, `langchain`, `otel`, `persist-fs`, `devtools` |

## One-time npm setup (done — kept as the record)

This section is complete: the `@langecs` scope is owned and all seven packages are live
on npm (0.1.0 and 0.2.0). Nothing here needs repeating — skip to
[Cutting a release](#cutting-a-release). It stays here because everything in it happens on
npmjs.com and is not automatable from this repo, so it is the only written trace of how
the registry side was set up.

### 1. Own the `@langecs` scope

`@langecs/*` needs the `langecs` scope to exist and belong to you. Before the first
publish nothing existed under it, and an *unpublished scope is not a reserved one* — the
org name is first-come. Create it at [npmjs.com/org/create](https://www.npmjs.com/org/create); the
free tier covers unlimited public packages.

### 2. Turn on 2FA

Account settings → Two-factor authentication, set to **Authorization and writes**.
Approving a staged release (step 5) requires it, and it is what stops a stolen password
from becoming a supply-chain incident.

### 3. Publish the first version by hand, once *(done: v0.1.0)*

npm cannot configure a trusted publisher for a package that does not exist yet, and OIDC
cannot create one — so the first version of each package goes out from your machine.
This is the only time you will do this.

```sh
git switch main && git pull
pnpm install --frozen-lockfile
pnpm build && pnpm test && pnpm typecheck && pnpm lint

pnpm publish:dry          # packs all seven, touches no registry — check the file lists

pnpm login                # opens a browser; 2FA here
pnpm publish:packages     # the real thing: all seven, --access public
```

`--access public` is not optional decoration: scoped packages default to *restricted*,
which a free account cannot publish.

### 4. Point each package at this repo's workflow

For each of the seven packages: npmjs.com → the package → **Settings** → **Trusted
publisher** → GitHub Actions, and fill in

| Field | Value |
|---|---|
| Organization or user | `bsteinfeld` |
| Repository | `langECS` |
| Workflow filename | `release.yml` |
| Environment | *(leave blank)* |

Leave Environment blank unless you also add `environment:` to the `release` job — npm
checks that the two agree, and a mismatch fails the publish with an auth error.

Once all seven are configured, delete any npm token you created; the workflow does not
need one.

### 5. Decide staged vs. direct publish

npm now defaults a new trusted publisher to **stage-only**: CI uploads the tarballs and
they stay invisible until you approve them with 2FA. The workflow matches that default,
so after a release you run:

```sh
pnpm stage list                 # what CI uploaded
pnpm stage view <stage-id>      # inspect one
pnpm stage download <stage-id>  # or pull the actual tarball
pnpm stage approve              # 2FA; one OTP covers the batch
```

That review step is worth keeping. If you would rather have CI publish straight through,
tick **Allow `npm publish`** on all seven trusted publishers, then set the repository
variable `NPM_PUBLISH_MODE` to `publish` (Settings → Secrets and variables → Actions →
Variables). Anything else leaves the workflow staging.

## Cutting a release

```sh
git switch main && git pull
pnpm version:all patch        # or minor / major / an explicit 0.2.0
git push --follow-tags origin main
```

`pnpm version:all` refuses to run on a dirty tree or on packages that have drifted out of
lockstep. It rewrites all seven versions, refreshes the lockfile, commits
`chore(release): v<version>`, and tags `v<version>` — it never pushes. Pushing the tag is
the irreversible step, and it is yours to take.

The workflow then reinstalls from the lockfile, checks the tag against every manifest,
runs build/test/typecheck/lint, packs, publishes (or stages), and opens a GitHub Release
with generated notes. A tag that disagrees with the manifests fails before the registry
is touched.

To rehearse without publishing: Actions → Release → **Run workflow**, leaving *dry run*
checked.

## If something goes wrong

**A version is already published.** npm does not allow republishing a version, and
unpublishing is restricted to a 72-hour window and breaks anyone who installed it. Ship
the fix as the next patch instead.

**A release half-published.** `pnpm publish -r` goes package by package, so a mid-run
failure can leave some packages at the new version and some behind. Fix the cause and
re-run the workflow — pnpm skips versions already on the registry, so it completes the
rest rather than starting over.

**`pnpm publish` 404s in CI.** Usually OIDC auth silently failing. Check that the job
still has `id-token: write`, that the trusted publisher's workflow filename is exactly
`release.yml`, and that `packageManager` in the root `package.json` is at least
`pnpm@11.1.3` — earlier pnpm 11 sent a literal `${NODE_AUTH_TOKEN}` placeholder as the
bearer token and the registry answered 404.

**You would rather use a token than OIDC.** Create a *granular* access token scoped to
the `@langecs` packages, store it as the `NPM_TOKEN` repository secret, and the workflow
picks it up automatically. It is a fallback: when a trusted publisher is also configured,
OIDC wins. Classic automation tokens work too but are long-lived and unscoped — prefer
granular ones, with an expiry.

## Provenance

Publishing over OIDC from a public repo makes npm generate and attach a provenance
attestation automatically — the "Built and signed on GitHub Actions" badge, linking each
published tarball to the commit and workflow run that produced it. This is why the
manifests do *not* set `publishConfig.provenance`: forcing it on would break the manual
first publish from a laptop, where there is no CI to attest to.
