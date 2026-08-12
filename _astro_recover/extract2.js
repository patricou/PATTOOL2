const fs = require('fs');
const path = require('path');

const targets = [
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/e0ea2004-7545-419c-b896-c17ad1317bef',
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea',
];
const out = 'C:/Dev/PATTOOL2/_astro_recover';

function walkDir(d, acc = []) {
  if (!fs.existsSync(d)) return acc;
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walkDir(p, acc);
    else if (ent.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

const recovered = {};
const metaByKey = {};
const events = [];

function frScore(s) {
  if (typeof s !== 'string') return 0;
  let score = 0;
  if (/[éèêàùôîçœÉÈÀÂÊÎÔÛ]/.test(s)) score += 3;
  if (
    /Aucune|Boussole|Nord|étoile|Étoile|galaxie|Galaxie|inclin|azimut|Azimut|cible|téléphone|Démarrer|Arrêter|Recaler|Caler|Capteur|Soleil|Visibl|Planète|Saturation|Satellites|Chercher|Choisissez|Orientez|Inclinez|Levez|Baissez|Rafraîch/i.test(
      s
    )
  )
    score += 2;
  if (/\b(the|and|your|phone|North|Select|Filter|galaxy|star|Please|Tap|Confirm)\b/i.test(s))
    score -= 2;
  return score;
}

function setKey(k, v, meta) {
  if (typeof v !== 'string' || !k) return;
  // skip junk
  if (k === 'ASTRO_COMPASS' && v.length < 40) {
    // menu label - keep separately
  }
  const prev = recovered[k];
  if (
    !prev ||
    frScore(v) > frScore(prev) ||
    (frScore(v) === frScore(prev) && v.length >= prev.length)
  ) {
    recovered[k] = v;
  }
  if (!metaByKey[k]) metaByKey[k] = [];
  metaByKey[k].push({ meta, v: v.slice(0, 80), score: frScore(v) });
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
    for (let j = brace; j < s.length && j < brace + 120000; j++) {
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
      const raw = s.slice(brace, end + 1);
      try {
        const obj = JSON.parse(raw);
        const keys = Object.keys(obj);
        events.push({ meta, kind: 'parsed_ASTRO_COMPASS', keys: keys.length });
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') setKey(k, v, meta + ':parsed');
        }
        // save full block if large
        if (keys.length >= 40) {
          fs.writeFileSync(
            path.join(out, 'block_' + keys.length + '_' + Date.now() + '.json'),
            JSON.stringify(obj, null, 2)
          );
        }
      } catch (e) {
        // try fixing trailing commas etc - also save raw for inspection if large
        if (raw.length > 2000) {
          const fname =
            'raw_astro_' +
            path.basename(meta).replace(/[^a-zA-Z0-9._-]/g, '_') +
            '_' +
            raw.length +
            '.txt';
          fs.writeFileSync(path.join(out, fname), raw.slice(0, 100000));
          events.push({
            meta,
            kind: 'raw_saved',
            len: raw.length,
            err: String(e.message).slice(0, 80),
            file: fname,
          });
        }
      }
    }
    searchFrom = i + 1;
  }
}

function extractFrScriptBlock(text, meta) {
  const re = /\bfr\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length && j < open + 30000; j++) {
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
    const keyRe = /([A-Z][A-Z0-9_]+)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
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
    if (n) events.push({ meta, kind: 'fr_script_block', keys: n });
  }

  // single-string maps: const map = { fr: '...', en: '...' }
  if (/GALAXIES_NONE_VISIBLE|gal-none/.test(text)) {
    const sm = text.match(/\bfr\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    if (sm) setKey('GALAXIES_NONE_VISIBLE', sm[2].replace(/\\'/g, "'"), meta);
  }
  if (/STARS_NONE_VISIBLE/.test(text) && /\bfr\s*:\s*['"`]/.test(text)) {
    // from inline node -e stars map
    const sm = text.match(/stars\s*=\s*\{[\s\S]*?\bfr\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    // may not have fr in stars map - check separately
  }
}

function extractKv(s, meta) {
  const keyVal = /"([A-Z][A-Z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  let n = 0;
  while ((m = keyVal.exec(s))) {
    const val = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    // only collect if value looks FR or key is known ASTRO-ish
    const astroKey =
      /^(TITLE|SUBTITLE|CAL_|TILT_|LOOK_|AUTO_|BODY_|STAR_|GALAX|SATELLITE|ISS_|VISIBLE|SELECTED|NORTH|TURN_|FACING|KIND_|UPDATED|AZIMUTH|ELEVATION|GPS|SENSOR|SUN_|MOUSE|MANUAL|CUSTOM|PLANETS|COORD|HEADING|PITCH|COMPASS|LAT|LON|PLACE|ERROR|LOADING|REFRESH|PASS|ALT_|RA_|DEC_|MAG_|HINT|STATUS|TARGET|NEEDLE|DIAL|RESET|SAVE|CANCEL|DONE|OPEN|CLOSE|LIVE_|FOUND|SCAN|AIM|CLEAR|FILTER|NONE_|PHONE_|DEVICE_|HORIZON|BELOW|ABOVE|AGO_|SEC|MIN|HOUR|DAY|WEEK|MONTH|YEAR|REL_|ABS_|ENABLE|DISABLE|PERMISSION|ACCURACY|SAMPLE|METHOD|OFFSET|REDO|CONFIRM|HINT|DRAG|STEP|INSTR|WARN|OK$)/.test(
        m[1]
      );
    if (!astroKey && !s.includes('ASTRO_COMPASS')) continue;
    if (astroKey || frScore(val) > 0) {
      setKey(m[1], val, meta + ':kv');
      n++;
    }
  }
  if (n > 10) events.push({ meta, kind: 'kv_dump', keys: n });
}

function scanString(s, meta) {
  if (!s || typeof s !== 'string') return;
  const hit =
    s.includes('ASTRO_COMPASS') ||
    s.includes('SATELLITES_TITLE') ||
    s.includes('LOOK_TITLE') ||
    s.includes('CAL_MODAL') ||
    s.includes('TILT_OK') ||
    s.includes('AUTO_MODAL') ||
    s.includes('_i18n') ||
    s.includes('tmp-i18n') ||
    s.includes('byLang') ||
    s.includes('GALAXIES_TITLE') ||
    s.includes('AUTO_DETECT') ||
    s.includes('BODY_SUN') ||
    s.includes('PLANETS_TITLE');
  if (!hit) return;
  tryParseAstroObject(s, meta);
  extractFrScriptBlock(s, meta);
  if (
    meta.includes('fr.json') ||
    s.includes('fr.json') ||
    s.includes('"ASTRO_COMPASS"') ||
    s.includes('SATELLITES_TITLE')
  ) {
    extractKv(s, meta);
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
    for (const field of ['contents', 'command', 'new_string', 'old_string']) {
      if (input[field]) scanString(String(input[field]), m2 + ':' + field + ':' + (input.path || ''));
    }
    if (input.path && String(input.path).includes('i18n')) {
      scanString(JSON.stringify(input), m2 + ':input');
    }
  }
  if (content.type === 'tool_result' || content.type === 'text') {
    const t = content.text || content.content || '';
    if (typeof t === 'string') scanString(t, meta + ':' + content.type);
    else walkContent(t, meta + ':' + content.type);
  }
  for (const [k, v] of Object.entries(content)) {
    if (typeof v === 'string') scanString(v, meta + ':' + k);
    else if (v && typeof v === 'object') walkContent(v, meta + ':' + k);
  }
}

const files = [];
for (const t of targets) walkDir(t, files);

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    // also scan raw line for SATELLITES even if JSON parse weird
    if (line.includes('SATELLITES_TITLE') || line.includes('LOOK_TITLE')) {
      scanString(line, path.basename(f) + ':L' + (i + 1) + ':rawline');
    }
    try {
      const obj = JSON.parse(line);
      walkContent(
        obj.message?.content || obj,
        path.basename(f) + ':L' + (i + 1) + ':' + (obj.role || '')
      );
    } catch (e) {}
  });
}

// Prefer FR: drop keys that are clearly English if we have alternatives... already scored

fs.writeFileSync(path.join(out, 'recovered_merged.json'), JSON.stringify(recovered, null, 2));
fs.writeFileSync(path.join(out, 'events2.json'), JSON.stringify(events, null, 2));
fs.writeFileSync(path.join(out, 'metaByKey.json'), JSON.stringify(metaByKey, null, 2));

console.log('files', files.length);
console.log('recovered', Object.keys(recovered).length);
console.log('events', events.length);
console.log(
  'events summary',
  events
    .filter((e) => e.keys >= 10 || e.kind === 'parsed_ASTRO_COMPASS' || e.kind === 'raw_saved')
    .slice(0, 30)
);
console.log('has SATELLITES_TITLE', recovered.SATELLITES_TITLE);
console.log('has LOOK_TITLE', recovered.LOOK_TITLE);
console.log('has TITLE', recovered.TITLE);
console.log('keys', Object.keys(recovered).sort().join('\n'));
