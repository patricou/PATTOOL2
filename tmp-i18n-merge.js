const fs = require('fs');
const path = require('path');

function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = typeof v === 'string' ? v : '';
  }
  return out;
}

function setPath(root, dotted, value) {
  const parts = dotted.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(root, dotted) {
  const parts = dotted.split('.');
  let cur = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

const dir = path.join('PatTool_Front-End', 'src', 'assets', 'i18n');
const en = flat(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')));
const langs = ['de', 'es', 'it', 'ar', 'cn', 'el', 'he', 'in', 'jp', 'ru'];
const files = {};
for (const l of langs) {
  files[l] = JSON.parse(fs.readFileSync(path.join(dir, l + '.json'), 'utf8'));
}

let applied = 0;
let skipped = 0;
for (let n = 1; n <= 5; n++) {
  const outPath = 'tmp-tr-out-' + n + '.json';
  if (!fs.existsSync(outPath)) {
    console.log('missing', outPath);
    continue;
  }
  const patch = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  for (const [key, byLang] of Object.entries(patch)) {
    if (!byLang || typeof byLang !== 'object') continue;
    for (const [lang, value] of Object.entries(byLang)) {
      if (!files[lang] || typeof value !== 'string' || !value.trim()) continue;
      const current = getPath(files[lang], key);
      if (current == null || current === en[key]) {
        setPath(files[lang], key, value);
        applied++;
      } else {
        skipped++;
      }
    }
  }
}

for (const l of langs) {
  fs.writeFileSync(path.join(dir, l + '.json'), JSON.stringify(files[l], null, 2) + '\n');
}
console.log('applied', applied, 'skipped-existing', skipped);
