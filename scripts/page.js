#!/usr/bin/env node
// The report page (docs/, served by GitHub Pages) reads reports with the same code the TV wrote them
// with. This copies that code into docs/; a test fails if the copy and the original ever differ.
//   npm run page
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const from = path.join(ROOT, 'app', 'src', 'main', 'assets', 'probe-core.js');
const to = path.join(ROOT, 'docs', 'probe-core.js');
fs.copyFileSync(from, to);
console.log('[probe] docs/probe-core.js is the app\'s probe-core.js (' + fs.statSync(to).size + ' bytes)');
