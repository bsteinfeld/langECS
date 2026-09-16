#!/usr/bin/env node
// Test the published boundary without rewriting tracked manifests. In particular,
// workspace source tests cannot detect a satellite installing its own core copy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'langecs-packaging-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

try {
  const archives = join(scratch, 'archives');
  mkdirSync(archives);
  const coreVersion = json(join(root, 'packages/core/package.json')).version;
  const packed = new Map();
  for (const name of readdirSync(join(root, 'packages'))) {
    const dir = join(root, 'packages', name);
    const manifest = json(join(dir, 'package.json'));
    if (manifest.private) continue;
    const before = new Set(readdirSync(archives));
    run('pnpm', ['pack', '--pack-destination', archives], dir);
    const added = readdirSync(archives).filter((file) => !before.has(file));
    assert.equal(added.length, 1, `${manifest.name}: expected one new archive`);
    const archive = join(archives, added[0]);
    const published = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
    const files = run('tar', ['-tf', archive], root).split('\n');
    assert.ok(files.includes('package/dist/index.js'), `${manifest.name}: build output missing`);
    if (manifest.name === '@langecs/core') {
      assert.equal(Object.keys(published.dependencies ?? {}).length, 0, 'core must have zero runtime dependencies');
    } else {
      assert.equal(published.peerDependencies?.['@langecs/core'], `^${coreVersion}`, `${manifest.name}: missing core peer`);
      assert.equal(published.dependencies?.['@langecs/core'], undefined, `${manifest.name}: core must not be a regular dependency`);
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const range of Object.values(published[field] ?? {})) {
        assert.ok(!range.startsWith('workspace:'), `${manifest.name}: unresolved workspace range`);
      }
    }
    packed.set(manifest.name, archive);
    console.log(`Checked ${manifest.name}@${published.version}`);
  }

  // Change a copy of the packed core, never the working tree: a prior manual
  // experiment accidentally reverted a real manifest fix along with its version.
  const unpack = join(scratch, 'core-copy');
  mkdirSync(unpack);
  run('tar', ['-xf', packed.get('@langecs/core'), '-C', unpack], root);
  const copiedCore = join(unpack, 'package');
  const coreManifestPath = join(copiedCore, 'package.json');
  const coreManifest = json(coreManifestPath);
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(coreVersion);
  assert.ok(match, `Invalid core version: ${coreVersion}`);
  coreManifest.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  writeFileSync(coreManifestPath, `${JSON.stringify(coreManifest, null, 2)}\n`);
  const patchedArchive = join(scratch, 'core-newer-patch.tgz');
  run('tar', ['-czf', patchedArchive, '-C', unpack, 'package'], root);

  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'langecs-packaging-probe', private: true, type: 'module',
    dependencies: {
      '@langecs/core': `file:${patchedArchive}`,
      '@langecs/stdlib': `file:${packed.get('@langecs/stdlib')}`,
    },
  }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--strict-peer-deps', '--cache', join(scratch, 'npm-cache')], consumer);
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createWorld, getComponentByName } from '@langecs/core';
    import { Messages } from '@langecs/stdlib';
    assert.equal(getComponentByName(Messages.componentName), Messages);
    const world = createWorld();
    world.spawn(Messages([]));
    const restored = createWorld();
    restored.load(world.snapshot());
    assert.deepEqual(restored.snapshot(), world.snapshot());
  `], consumer);
  console.log(`Packed consumer shares core ${coreManifest.version}; snapshot round-trip passed.`);
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
