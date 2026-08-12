const fs = require('fs');
const path = require('path');

const out = 'C:/Dev/PATTOOL2/_astro_recover';
const e0 =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/e0ea2004-7545-419c-b896-c17ad1317bef/e0ea2004-7545-419c-b896-c17ad1317bef.jsonl';
const t7 =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea.jsonl';

const merged = JSON.parse(
  fs.readFileSync(path.join(out, 'ASTRO_COMPASS_FR_FINAL.json'), 'utf8')
);

function extractFrBlock(text) {
  const o = {};
  const re = /\bfr\s*(?:Extra)?\s*=\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length && j < open + 50000; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (!depth) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = text.slice(open + 1, end);
    const keyRe = /([A-Z][A-Z0-9_]+)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    let km;
    while ((km = keyRe.exec(body))) {
      o[km[1]] = km[3]
        .replace(/\\n/g, '\n')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\`/g, '`');
    }
  }
  // also const fr = {
  const re2 = /\bconst fr\s*=\s*\{/g;
  while ((m = re2.exec(text))) {
    const open = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length && j < open + 20000; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (!depth) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = text.slice(open + 1, end);
    const keyRe = /([A-Z][A-Z0-9_]+)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    let km;
    while ((km = keyRe.exec(body))) {
      o[km[1]] = km[3]
        .replace(/\\n/g, '\n')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"');
    }
  }
  return o;
}

function process(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      const contents = String((c.input && c.input.contents) || '');
      const command = String((c.input && c.input.command) || '');
      const blob = contents || command;
      if (
        !/frExtra|const fr\s*=|ADDRESS_REQUIRED|VIS_NOW_VISIBLE|CAL_METHOD_MOUSE|VIS_DURATION/.test(
          blob
        )
      )
        continue;
      const block = extractFrBlock(blob);
      const n = Object.keys(block).length;
      if (n) {
        console.log(
          path.basename(file) + ':L' + (i + 1),
          'keys',
          n,
          Object.keys(block).slice(0, 15).join(',')
        );
        Object.assign(merged, block);
        fs.writeFileSync(
          path.join(out, 'extra_' + path.basename(file) + '_L' + (i + 1) + '.json'),
          JSON.stringify(block, null, 2)
        );
      }
    }
  });
}

process(e0);
process(t7);

// Sort keys for stable output
const sorted = {};
for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
fs.writeFileSync(
  path.join(out, 'ASTRO_COMPASS_FR_FINAL.json'),
  JSON.stringify(sorted, null, 2)
);
console.log('final total', Object.keys(sorted).length);

const stillMissing = [
  'KIND_SATELLITE',
  'ADDRESS_REQUIRED',
  'VIS_NOW_VISIBLE',
  'CAL_METHOD_MOUSE',
  'BODY_TIANGONG',
  'BODY_HUBBLE',
];
for (const k of stillMissing) console.log(k, sorted[k] || 'STILL MISSING');
