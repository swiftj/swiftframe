// Builds all three packages.
//
// The Homebridge plugin and the MCP server each bundle the shared core into a single file, so
// either can be installed on its own (from a tarball or from npm) without the core being published.
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const { version } = JSON.parse(readFileSync(at('package.json'), 'utf8'));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  alias: { 'swiftframe-core': at('packages/core/src/index.ts') },
  define: { __SWIFTFRAME_VERSION__: JSON.stringify(version) },
};

for (const dir of ['core', 'homebridge', 'mcp']) {
  rmSync(at(`packages/${dir}/dist`), { recursive: true, force: true });
}

await build({
  ...shared,
  entryPoints: [at('packages/core/src/index.ts')],
  outfile: at('packages/core/dist/index.js'),
  external: ['ws'],
});

execFileSync('npx', ['tsc', '-p', 'packages/core/tsconfig.build.json'], { cwd: root, stdio: 'inherit' });

await build({
  ...shared,
  entryPoints: [at('packages/homebridge/src/index.ts')],
  outfile: at('packages/homebridge/dist/index.js'),
  external: ['ws', 'homebridge'],
});

await build({
  ...shared,
  entryPoints: [at('packages/mcp/src/index.ts')],
  outfile: at('packages/mcp/dist/index.js'),
  external: ['ws', 'zod', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
});

chmodSync(at('packages/mcp/dist/index.js'), 0o755);

console.log('Built core, homebridge and mcp.');
