import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  format: 'esm',
  // package.json#publishConfig points at dist/index.js + dist/index.d.ts;
  // the package is "type": "module", so .js is already ESM.
  fixedExtension: false,
});
