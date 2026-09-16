#!/usr/bin/env node
/**
 * Lockstep version bump for every publishable workspace package.
 *
 * All seven `packages/*` ship as one tested release. Satellites use a
 * `workspace:^` core peer: compatible patches can share one host core, while
 * 0.x minor upgrades require upgrading the related packages together.
 *
 *   pnpm version:all 0.2.0     # explicit version
 *   pnpm version:all patch     # or minor / major / prerelease
 *   pnpm version:all 0.2.0 --dry-run
 *
 * Writes the new version into every packages/*\/package.json, refreshes the
 * lockfile, commits, and tags `v<version>`. Pushing that tag is what triggers
 * .github/workflows/release.yml — this script never pushes.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, 'packages');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const request = args.find((a) => !a.startsWith('--'));

if (!request) {
  console.error('usage: pnpm version:all <version|major|minor|patch|premajor|preminor|prepatch|prerelease> [--dry-run]');
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

// A release tag must describe a known commit, so refuse to build one out of a
// dirty tree. --dry-run skips the check so you can preview from a work branch.
if (!dryRun && git('status', '--porcelain')) {
  console.error('working tree is dirty — commit or stash first (or pass --dry-run)');
  process.exit(1);
}

const manifests = readdirSync(packagesDir)
  .map((name) => ({ name, path: join(packagesDir, name, 'package.json') }))
  .filter(({ path }) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  })
  .map((pkg) => ({ ...pkg, json: JSON.parse(readFileSync(pkg.path, 'utf8')) }));

if (manifests.length === 0) {
  console.error('no packages found under packages/');
  process.exit(1);
}

// Lockstep means they start in lockstep: a drift here is a bug to fix by hand,
// not something to paper over by bumping from an arbitrary package's version.
const current = [...new Set(manifests.map((m) => m.json.version))];
if (current.length > 1) {
  console.error(`packages are not in lockstep: ${manifests.map((m) => `${m.json.name}@${m.json.version}`).join(', ')}`);
  process.exit(1);
}

const next = resolveVersion(current[0], request);
if (next === current[0]) {
  console.error(`version is already ${next}`);
  process.exit(1);
}

console.log(`${current[0]} -> ${next}`);
for (const m of manifests) {
  console.log(`  ${m.json.name}`);
  if (dryRun) continue;
  // Rewrite only the version line, so field order and formatting stay put.
  const raw = readFileSync(m.path, 'utf8');
  const patched = raw.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${next}"`);
  if (patched === raw) {
    console.error(`could not rewrite the version field of ${m.path}`);
    process.exit(1);
  }
  writeFileSync(m.path, patched);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written');
  process.exit(0);
}

// Workspace package versions appear in the lockfile's importers, so refresh it
// before committing or CI's --frozen-lockfile install will fail.
execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });

git('add', '--', 'packages', 'pnpm-lock.yaml');
git('commit', '-m', `chore(release): v${next}`);
git('tag', '-a', `v${next}`, '-m', `v${next}`);

console.log(`\ncommitted and tagged v${next}`);
console.log(`push it to publish:  git push --follow-tags origin ${git('rev-parse', '--abbrev-ref', 'HEAD')}`);

/** Minimal semver bump — enough for the keywords `npm version` accepts. */
function resolveVersion(from, req) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(req)) return req;

  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(from);
  if (!m) {
    console.error(`cannot parse current version "${from}"`);
    process.exit(1);
  }
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4];

  switch (req) {
    case 'major':
      return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
    case 'minor':
      return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case 'patch':
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case 'premajor':
      return `${major + 1}.0.0-0`;
    case 'preminor':
      return `${major}.${minor + 1}.0-0`;
    case 'prepatch':
      return `${major}.${minor}.${patch + 1}-0`;
    case 'prerelease': {
      if (!pre) return `${major}.${minor}.${patch + 1}-0`;
      const parts = pre.split('.');
      const last = parts.length - 1;
      const n = Number(parts[last]);
      parts[last] = Number.isInteger(n) ? String(n + 1) : `${parts[last]}.0`;
      return `${major}.${minor}.${patch}-${parts.join('.')}`;
    }
    default:
      console.error(`unrecognized version request "${req}"`);
      process.exit(1);
  }
}
