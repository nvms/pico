import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['./src/main.jsx'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  jsxImportSource: '@trendr/core',
  outfile: 'dist/pico.js',
  sourcemap: 'inline',
})
