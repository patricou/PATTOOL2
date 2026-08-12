const fs = require('fs');
const path = require('path');

const dir =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea';
const out = 'C:/Dev/PATTOOL2/_astro_recover';
fs.mkdirSync(out, { recursive: true });

function walkDir(d, acc = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walkDir(p, acc);
    else if (ent.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

const recovered = {};
const snippets = [];
const sources = {}; // key -> list of metas

function frScore(s) {
  if (typeof s !== 'string') return 0;
  let score = 0;
  if (/[éèêàùôîçœÉÈÀÂÊÎÔÛ]/.test(s)) score += 3;
  if (
    /Aucune|Boussole|Nord|étoile|Étoile|galaxie|Galaxie|inclin|azimut|Azimut|cible|téléphone|Démarrer|Arrêter|Recaler|Capteur|Soleil|Visibl/i.test(
      s
    )
  )
    score += 2;
  if (/the |and |your |phone|North|Select|Filter|galaxy|star /i.test(s)) score -= 2;
  return score;
}

function setKey(k, v, meta) {
  if (typeof v !== 'string' || !k) return;
  const prev = recovered[k];
  if (!prev || frScore(v) > frScore(prev) || (frScore(v) === frScore(prev) && v.length > prev.length)) {
    recovered[k] = v;
  }
  if (!sources[k]) sources[k] = [];
  sources[k].push(meta);
}

function tryParseAstroObject(s, meta) {
  let searchFrom = 0;
  while (true) {
    const i = s.indexOf('"ASTRO_COMPASS"', searchFrom);
    if (i < 0) break;
    const brace = s.indexOf('{', i);
    if (brace < 0 || brace - i > 40) {
      searchFrom = i + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let j = brace; j < s.length && j < brace + 80000; j++) {
      const c = s[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > 0) {
      try {
        const obj = JSON.parse(s.slice(brace, end + 1));
        const keys = Object.keys(obj);
        snippets.push({ meta, kind: 'parsed_ASTRO_COMPASS', keys: keys.length });
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') setKey(k, v, meta + ':parsed');
        }
      } catch (e) {
        snippets.push({
          meta,
          kind: 'parse_fail',
          err: String(e.message).slice(0, 100),
          preview: s.slice(brace, brace + 120),
        });
      }
    }
    searchFrom = i + 1;
  }
}

function extractFrScriptBlock(text, meta) {
  // Find fr: { ... } then en:
  const markers = [];
  const re = /\bfr\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text))) markers.push(m.index);
  for (const start of markers) {
    const open = text.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length && j < open + 20000; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = text.slice(open + 1, end);
    const keyRe =
      /([A-Z][A-Z0-9_]+)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    let km;
    let n = 0;
    while ((km = keyRe.exec(body))) {
      let val = km[3]
        .replace(/\\n/g, '\n')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\`/g, '`');
      setKey(km[1], val, meta + ':fr_block');
      n++;
    }
    // also fr: 'single string' style maps elsewhere
    if (n) snippets.push({ meta, kind: 'fr_script_block', keys: n });
  }

  // map = { fr: 'string', en: 'string' } for single-key scripts
  const singleRe = /\bfr\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  while ((m = singleRe.exec(text))) {
    const val = m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"');
    // guess key from nearby context
    if (/GALAXIES_NONE_VISIBLE|gal-none|GALAXIES_NONE/.test(text.slice(Math.max(0, m.index - 200), m.index + 200))) {
      setKey('GALAXIES_NONE_VISIBLE', val, meta + ':fr_single');
    }
    if (/STARS_NONE_VISIBLE|stars.?none/i.test(text.slice(Math.max(0, m.index - 200), m.index + 200))) {
      setKey('STARS_NONE_VISIBLE', val, meta + ':fr_single');
    }
    if (/AUTO_FOUND|AUTO_FOUND/.test(text.slice(Math.max(0, m.index - 400), m.index + 100))) {
      // may be object or string
    }
  }
}

function extractKvNearAstro(s, meta) {
  if (!/"[A-Z][A-Z0-9_]+"\s*:\s*"/.test(s)) return;
  const keyVal = /"([A-Z][A-Z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  let n = 0;
  const prefix =
    /^(CAL_|TILT_|LOOK_|AUTO_|BODY_|STAR_|GALAX|SATELLITE|ISS_|TITLE|SUBTITLE|VISIBLE|SELECTED|NORTH|TURN_|FACING|KIND_|UPDATED|AZIMUTH|ELEVATION|GPS|SENSOR|SUN_|MOUSE|MANUAL|CUSTOM|PLANETS|COORD|HEADING|PITCH|COMPASS|LAT|LON|PLACE|ERROR|LOADING|REFRESH|PASS|ALT|RA_|DEC_|MAG_|HINT|STATUS|TARGET|NEEDLE|DIAL|RESET|SAVE|CANCEL|DONE|OPEN|CLOSE|LIVE_|FOUND|SCAN|AIM|CLEAR|FILTER|NONE_|OK$)/;
  while ((m = keyVal.exec(s))) {
    if (
      prefix.test(m[1]) ||
      s.includes('ASTRO_COMPASS') ||
      /fr\.json/.test(meta)
    ) {
      const val = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      // skip English-looking values if we already have FR? still collect
      setKey(m[1], val, meta + ':kv');
      n++;
    }
  }
  if (n > 8) snippets.push({ meta, kind: 'kv_dump', keys: n });
}

function scanString(s, meta) {
  if (!s || typeof s !== 'string') return;
  const hit =
    s.includes('ASTRO_COMPASS') ||
    s.includes('CAL_MODAL') ||
    s.includes('TILT_OK') ||
    s.includes('SATELLITES_TITLE') ||
    s.includes('LOOK_TITLE') ||
    s.includes('AUTO_MODAL') ||
    s.includes('_i18n') ||
    s.includes('tmp-i18n') ||
    s.includes('byLang') ||
    s.includes('GALAXIES_TITLE') ||
    s.includes('AUTO_DETECT') ||
    s.includes('TURN_OK');
  if (!hit) return;
  tryParseAstroObject(s, meta);
  extractFrScriptBlock(s, meta);
  if (meta.includes('fr.json') || s.includes('fr.json') || s.includes('"ASTRO_COMPASS"')) {
    extractKvNearAstro(s, meta);
  }
}

function walkContent(content, meta) {
  if (Array.isArray(content)) {
    for (const c of content) walkContent(c, meta);
    return;
  }
  if (!content || typeof content !== 'object') {
    if (typeof content === 'string') scanString(content, meta);
    return;
  }
  if (content.type === 'tool_use') {
    const name = content.name || '';
    const input = content.input || {};
    const m2 = meta + ':tool_use:' + name;
    if (input.contents) scanString(String(input.contents), m2 + ':contents:' + (input.path || ''));
    if (input.command) scanString(String(input.command), m2 + ':command');
    if (input.new_string) scanString(String(input.new_string), m2 + ':new_string:' + (input.path || ''));
    if (input.old_string) scanString(String(input.old_string), m2 + ':old_string:' + (input.path || ''));
    if (input.path && String(input.path).includes('fr.json')) {
      // also scan whole input
      scanString(JSON.stringify(input), m2 + ':input_json');
    }
  }
  if (content.type === 'tool_result' || content.type === 'text') {
    const t = content.text || content.content || '';
    if (typeof t === 'string') scanString(t, meta + ':' + content.type);
    else walkContent(t, meta + ':' + content.type);
  }
  for (const [k, v] of Object.entries(content)) {
    if (k === 'input' && content.type === 'tool_use') continue; // already handled
    if (typeof v === 'string') scanString(v, meta + ':' + k);
    else if (v && typeof v === 'object') walkContent(v, meta + ':' + k);
  }
}

const files = walkDir(dir);
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      walkContent(
        obj.message?.content || obj,
        path.basename(f) + ':L' + (i + 1) + ':' + (obj.role || '')
      );
    } catch (e) {
      // ignore
    }
  });
}

// Also dump any line that has a large ASTRO_COMPASS object size for inspection
const largeHits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\n/);
  lines.forEach((line, i) => {
    if (line.includes('"ASTRO_COMPASS"') && line.includes('CAL_NEEDED')) {
      largeHits.push({ file: path.basename(f), line: i + 1, len: line.length });
    }
  });
}

fs.writeFileSync(path.join(out, 'recovered_partial.json'), JSON.stringify(recovered, null, 2));
fs.writeFileSync(path.join(out, 'snippets.json'), JSON.stringify(snippets, null, 2));
fs.writeFileSync(path.join(out, 'sources.json'), JSON.stringify(sources, null, 2));
fs.writeFileSync(path.join(out, 'large_hits.json'), JSON.stringify(largeHits, null, 2));

console.log('files', files.length);
console.log('recovered keys', Object.keys(recovered).length);
console.log('snippets', snippets.length);
console.log('largeHits', largeHits);
console.log('keys', Object.keys(recovered).sort().join(', '));
