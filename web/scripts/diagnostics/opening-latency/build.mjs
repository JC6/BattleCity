import { readFile, writeFile, mkdir, cp, symlink, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceSnapshot, hashDirectory } from './common.mjs';
import { instrumentMain, instrumentWorklet } from './instrument.mjs';

// node build.mjs REPOSITORY NATIVE_WEB_DIRECTORY NEW_ARCHIVE_DIRECTORY [--scenario lifecycle]
const args = process.argv.slice(2);
if (args.length !== 3 && !(args.length === 5 && args[3] === '--scenario' && args[4] === 'lifecycle'))
  throw new Error('Usage: node build.mjs REPOSITORY NATIVE_WEB_DIRECTORY NEW_ARCHIVE_DIRECTORY [--scenario lifecycle]');
const [root, runtime, archive] = args.slice(0, 3).map(value => path.resolve(value));
const scenario = args[4] ?? 'opening';
const lifecycle = scenario === 'lifecycle' ? await import('./lifecycle-instrument.mjs') : undefined;
const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(runtime, 'package.json'));
const { build } = await import(require.resolve('vite'));
const source = await sourceSnapshot(root);
await mkdir(archive); // An archive is immutable input for one run; never overwrite an old one.
await writeFile(path.join(archive, 'source-at-build.json'), JSON.stringify(source, null, 2));
const frozen = path.join(archive, 'source');
for (const file of source.files) {
  const target = path.join(frozen, file.path); await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, file.path), target);
}
await cp(toolsDirectory, path.join(archive, 'tools'), { recursive: true });
// Helpers imported by the runner resolve from this frozen source tree as well.
await cp(toolsDirectory, path.join(frozen, 'web/scripts/diagnostics/opening-latency'), { recursive: true });
await symlink(path.join(runtime, 'node_modules'), path.join(frozen, 'web/node_modules'));
const scratch = await mkdtemp(`/tmp/battlecity-${scenario}-`);
const groups = {};
const configurations = lifecycle
  ? ['test', 'production'].flatMap(mode => [false, true].map(diagnostic => ({
    group: `${mode}-${diagnostic ? 'diagnostic' : 'baseline'}`, mode, diagnostic,
  })))
  : ['A', 'B', 'C'].map(group => ({ group, mode: 'production', diagnostic: group !== 'A' }));
for (const { group, mode, diagnostic } of configurations) {
  const workspace = path.join(scratch, group), web = path.join(workspace, 'web');
  await cp(frozen, workspace, { recursive: true, verbatimSymlinks: true });
  if (diagnostic) {
    const names = lifecycle ? ['src/platform/audio-runtime.ts', 'src/platform/apu-worklet.ts']
      : ['src/platform/input.ts', 'src/platform/audio-runtime.ts', 'src/app/controller.ts', 'src/platform/apu-worklet.ts'];
    for (const name of names) {
      const filename = path.join(web, name), original = await readFile(filename, 'utf8');
      const patched = lifecycle
        ? name.endsWith('apu-worklet.ts') ? lifecycle.instrumentLifecycleWorklet(original) : lifecycle.instrumentLifecycleMain(original)
        : name.endsWith('apu-worklet.ts') ? instrumentWorklet(original) : instrumentMain(original, name);
      await writeFile(filename, patched);
      const saved = path.join(archive, 'diagnostic-source', group, name);
      await mkdir(path.dirname(saved), { recursive: true }); await writeFile(saved, patched);
      if (lifecycle) {
        const diff = spawnSync('diff', ['-u', '--label', `a/${name}`, '--label', `b/${name}`,
          path.join(frozen, 'web', name), saved], { encoding: 'utf8' });
        if (![0, 1].includes(diff.status)) throw diff.error ?? new Error(diff.stderr || 'Could not archive instrumentation diff');
        await writeFile(`${saved}.patch`, diff.stdout);
      }
    }
  }
  if (group === 'C') {
    const minimal = (await readFile(path.join(toolsDirectory, 'minimal.ts'), 'utf8')).replaceAll("'../../../src/", "'./src/");
    await writeFile(path.join(web, 'minimal.ts'), minimal);
    await writeFile(path.join(web, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Opening audio diagnostic</title></head><body>Audio diagnostic<script type="module" src="/minimal.ts"></script></body></html>');
  }
  const outDir = path.join(archive, 'builds', group);
  await build({ root: web, configFile: path.join(web, 'vite.config.ts'), mode, build: { outDir, emptyOutDir: true } });
  const hashes = await hashDirectory(outDir);
  const code = (await Promise.all(Object.keys(hashes).filter(name => name.endsWith('.js')).map(name => readFile(path.join(outDir, name), 'utf8')))).join('\n');
  const markers = lifecycle ? ['__LIFECYCLE_TRACE__', '__lifecycle_dump'] : ['__OPENING_TRACE__', '__opening_dump'];
  if (!diagnostic && [...markers, '__OPENING_TRACE__', '__opening_dump', '__LIFECYCLE_TRACE__', '__lifecycle_dump'].some(marker => code.includes(marker)))
    throw new Error('Diagnostic code in baseline');
  if (diagnostic && markers.some(marker => !code.includes(marker))) throw new Error('Missing diagnostic instrumentation');
  if (mode === 'production' && code.includes('__BATTLECITY__')) throw new Error('Unexpected game test API');
  groups[group] = { label: lifecycle ? group : { A: 'current-production', B: 'instrumented-game', C: 'minimal-audio' }[group], mode, diagnostic, hashes,
    worklet: Object.keys(hashes).find(name => name.startsWith('assets/apu-worklet-')) };
}
if (!lifecycle && groups.B.hashes[groups.B.worklet] !== groups.C.hashes[groups.C.worklet]) throw new Error('B/C must use identical Worklet bytes');
const toolHashes = await hashDirectory(path.join(archive, 'tools'));
await writeFile(path.join(archive, 'build-manifest.json'), JSON.stringify({ scenario, sourceFingerprint: source.fingerprint, groups, toolHashes }, null, 2));
await writeFile(path.join(archive, 'config.json'), JSON.stringify({ root, runtime, archive, scratch,
  scenario, sourceFingerprint: source.fingerprint, url: 'http://127.0.0.1:4174/' }, null, 2));
for (const entry of ['run', 'analyze']) await build({ root: path.join(frozen, 'web'), configFile: false, mode: 'production',
  build: { ssr: path.join(frozen, `web/scripts/diagnostics/opening-latency/${lifecycle ? 'lifecycle-' : ''}${entry}.mjs`), outDir: path.join(archive, 'runner'),
    emptyOutDir: false, rolldownOptions: { output: { entryFileNames: `${entry}.mjs` } } } });
await symlink(path.join(runtime, 'node_modules'), path.join(archive, 'node_modules'));
const after = await sourceSnapshot(root);
if (after.fingerprint !== source.fingerprint) throw new Error('Product sources changed during build');
if (lifecycle) for (const directory of [toolsDirectory, path.join(frozen, 'web/scripts/diagnostics/opening-latency')]) {
  if (JSON.stringify(await hashDirectory(directory)) !== JSON.stringify(toolHashes)) throw new Error('Diagnostic tools changed during build');
}
console.log(JSON.stringify({ archive, scratch, sourceFingerprint: source.fingerprint, groups: Object.keys(groups) }));
