// Bundles src/ (React + CSS) into dist/. Run: npm run build   (or npm run dev to watch)
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['src/main.jsx'],
  bundle: true,
  outdir: 'dist',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch,
  target: ['es2020'],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync(path.join('public', 'index.html'), path.join('dist', 'index.html'));

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch()).then(() => console.log('Watching src/ ...'));
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
