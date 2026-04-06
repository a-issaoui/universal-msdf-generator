#!/usr/bin/env node
/**
 * Patches msdfgen-wasm's package.json exports to include a 'types' field.
 * The package (v1.0.0) ships types but omits them from its exports map,
 * which breaks TypeScript's moduleResolution: NodeNext.
 */
const fs = require('node:fs');
const path = require('node:path');

const pkgPath = path.join(__dirname, '..', 'node_modules', 'msdfgen-wasm', 'package.json');
if (!fs.existsSync(pkgPath)) {
  process.exit(0); // not installed yet — npm ci will call us again after install
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.exports?.['.']?.types) {
  process.exit(0); // already patched
}
pkg.exports['.'].types = './dist/types/index.d.ts';
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Patched msdfgen-wasm package.json exports.types');
