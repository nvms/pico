import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: { pico: './src/main.jsx', daemon: './src/daemon.js', 'linux-dictate': './helper/linux-dictate.js' },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  jsxImportSource: '@trendr/core',
  outdir: 'dist',
  sourcemap: 'inline',
})
