#!/usr/bin/env node
// Copy non-TS assets into dist/ (markdown templates used by workspace-initializer).
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (s.endsWith('.md')) fs.writeFileSync(d, fs.readFileSync(s, 'utf-8').replace(/\r\n?/g, '\n'), 'utf-8'); // LF (fixes #166)
    else fs.copyFileSync(s, d);
  }
}

const src = path.join(__dirname, '..', 'src', 'markdown');
if (fs.existsSync(src)) { copyDir(src, path.join(__dirname, '..', 'dist', 'markdown')); console.log('✓ Copied markdown templates'); }
