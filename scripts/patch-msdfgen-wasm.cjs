#!/usr/bin/env node
/**
 * Patches msdfgen-wasm's package.json exports (two fixes for v1.0.0):
 *
 * 1. Add 'types' to the exports map — required for TypeScript moduleResolution: NodeNext.
 *    The package ships dist/types/index.d.ts but doesn't reference it in exports.
 *
 * 2. Redirect 'import' to the CJS build — the ESM dist uses extension-less imports
 *    (e.g. './Msdfgen' instead of './Msdfgen.js'), which fail under Node.js strict ESM
 *    resolution. The CJS build has no such issue, and Node.js handles CJS-via-ESM import
 *    transparently via its CJS/ESM interoperability layer.
 */
const fs = require('node:fs');
const path = require('node:path');

const pkgPath = path.join(__dirname, '..', 'node_modules', 'msdfgen-wasm', 'package.json');
if (!fs.existsSync(pkgPath)) {
  process.exit(0); // not installed yet — postinstall will run again after npm install
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let changed = false;

// Fix 1: add types to exports map
if (!pkg.exports?.['.']?.types) {
  pkg.exports['.'].types = './dist/types/index.d.ts';
  changed = true;
}

// Fix 2: redirect import condition to CJS (ESM dist has extension-less imports)
if (pkg.exports?.['.']?.import !== './dist/cjs/index.js') {
  pkg.exports['.'].import = './dist/cjs/index.js';
  changed = true;
}

if (changed) {
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('Patched msdfgen-wasm package.json (types + import→cjs redirect)');
}
