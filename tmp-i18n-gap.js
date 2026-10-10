const fs = require('fs');
const path = require('path');
const dir = path.join('PatTool_Front-End', 'src', 'assets', 'i18n');
const langs = ['fr', 'de', 'es', 'it', 'ar', 'cn', 'el', 'he', 'in', 'jp', 'ru'];

function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = typeof v === 'string' ? v : '';
  }
  return out;
}

const en = flat(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')));
const data = {};
for (const l of langs) data[l] = flat(JSON.parse(fs.readFileSync(path.join(dir, l + '.json'), 'utf8')));

function isLongDoc(key, value) {
  if (!value) return false;
  if (value.length > 320) return true;
  if ((value.match(/\n/g) || []).length >= 2 && value.length > 180) return true;
  if (/HELP_|_GUIDE|_MANUAL|DOC_|DOCUMENT|_README|ABOUT_TEXT|LONG_/.test(key) && value.length > 180) return true;
  return false;
}

const skipSame = new Set([
  'SOS', 'GPS', 'PDF', 'URL', 'OK', 'JSON', 'GPX', 'ISS', 'NASA', 'CERN', 'TV', 'AI', 'LAN', 'USB', 'HDMI', 'Wi-Fi', 'WiFi', 'Email', 'email'
]);

function sameOk(enVal) {
  if (enVal.length <= 3) return true;
  if (skipSame.has(enVal)) return true;
  if (/^https?:\/\//.test(enVal)) return true;
  if (/^\{\{[^}]+\}\}$/.test(enVal.trim())) return true;
  return false;
}

const todo = {};
for (const l of langs) {
  const missing = [];
  const copied = [];
  let skippedLong = 0;
  for (const [k, v] of Object.entries(en)) {
    if (isLongDoc(k, v)) {
      if (!(k in data[l]) || data[l][k] === v) skippedLong++;
      continue;
    }
    if (!(k in data[l])) missing.push(k);
    else if (l !== 'en' && data[l][k] === v && !sameOk(v) && /[A-Za-zÀ-ÿ]{4,}/.test(v)) copied.push(k);
  }
  todo[l] = { missing: missing.length, copied: copied.length, skippedLong };
  console.log(l, 'missing', missing.length, 'english-copy', copied.length, 'skipped-long', skippedLong);
}

const union = new Map();
for (const l of langs) {
  for (const k of Object.keys(en)) {
    if (isLongDoc(k, en[k])) continue;
    const present = k in data[l];
    const copied = present && data[l][k] === en[k] && !sameOk(en[k]) && /[A-Za-zÀ-ÿ]{4,}/.test(en[k]);
    if (!present || (l !== 'fr' && copied) || (l === 'fr' && copied)) {
      if (!union.has(k)) union.set(k, { missing: [], copied: [] });
      const u = union.get(k);
      if (!present) u.missing.push(l);
      else if (copied) u.copied.push(l);
    }
  }
}
console.log('unique keys needing work', union.size);

const byRoot = {};
for (const [k, info] of union) {
  const root = k.split('.')[0];
  if (!byRoot[root]) byRoot[root] = { n: 0, sample: [] };
  byRoot[root].n++;
  if (byRoot[root].sample.length < 3) byRoot[root].sample.push(k + ' = ' + en[k].slice(0, 80));
}
const rows = Object.entries(byRoot).sort((a, b) => b[1].n - a[1].n);
for (const [root, info] of rows) {
  console.log(root, info.n);
}

fs.writeFileSync('tmp-i18n-gap.json', JSON.stringify({
  keys: [...union.entries()].map(([k, info]) => ({ k, en: en[k], ...info }))
}, null, 0));
console.log('wrote tmp-i18n-gap.json', union.size);
