#!/usr/bin/env node
'use strict';
/**
 * Build the deployment package layout in ./deploy-stage:
 *   host.json, package.json, package-lock.json, src/ (full tree),
 *   plus one root shim folder per function whose function.json points
 *   its scriptFile into ../src/functions/<name>/index.js.
 *
 * The Azure Functions runtime only discovers function.json in DIRECT
 * children of wwwroot — the shims bridge that to the src/ layout so
 * require('../../lib/...') paths keep resolving correctly.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const stage = path.join(repoRoot, 'deploy-stage');
const srcFunctions = path.join(repoRoot, 'src', 'functions');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ['host.json', 'package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(repoRoot, f), path.join(stage, f));
}
fs.cpSync(path.join(repoRoot, 'src'), path.join(stage, 'src'), { recursive: true });

let shims = 0;
for (const name of fs.readdirSync(srcFunctions)) {
  const fjPath = path.join(srcFunctions, name, 'function.json');
  if (!fs.existsSync(fjPath)) continue;
  const fj = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
  fj.scriptFile = `../src/functions/${name}/index.js`;
  const shimDir = path.join(stage, name);
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'function.json'), JSON.stringify(fj, null, 2));
  shims++;
}

console.log(`deploy-stage ready: ${shims} function shims + src tree`);
