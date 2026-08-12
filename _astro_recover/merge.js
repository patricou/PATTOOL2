const fs = require('fs');
const path = require('path');

const out = 'C:/Dev/PATTOOL2/_astro_recover';
const e0 =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/e0ea2004-7545-419c-b896-c17ad1317bef/e0ea2004-7545-419c-b896-c17ad1317bef.jsonl';
const t7 =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea/7ca33cae-94fc-4f96-bf90-2d0c3b4b5cea.jsonl';

const frBase = JSON.parse(
  fs.readFileSync(path.join(out, '_i18n_fr_from_transcript.json'), 'utf8')
);
const merged = { ...frBase };
const overlayLog = [];

function frScore(s) {
  if (typeof s !== 'string') return 0;
  let sc = 0;
  if (/[éèêàùôîçœÉÈÀÂÊÎÔÛ]/.test(s)) sc += 3;
  if (
    /Aucune|Boussole|Nord|étoile|Étoile|galaxie|Galaxie|inclin|azimut|Azimut|cible|téléphone|Caler|Recalage|Choisissez|Orientez|Visée|Système|Soleil|Capteur|Marche|Confirmer|Enregistrer|Recaler|Localisation|Déclinaison|Ascension|Élongation|Pluton|Vénus|Mercure|Levez|Baissez|Rafraîch|Démarrer|Arrêter|Identifié|candidats|Visibl|Satellites|Planète|Galaxie/i.test(
      s
    )
  )
    sc += 2;
  if (
    /\b(the|and|your|phone|North|Select|Filter|Please|Tap|Confirm|Waiting|Could|Show only|Visible bodies)\b/i.test(
      s
    )
  )
    sc -= 2;
  return sc;
}

function overlay(obj, meta) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue;
    if (k === 'ASTRO_COMPASS') continue;
    const prev = merged[k];
    if (!prev) {
      merged[k] = v;
      overlayLog.push({ k, meta, action: 'add', v });
      continue;
    }
    const ps = frScore(prev);
    const ns = frScore(v);
    if (v === prev) continue;
    // Prefer stronger French; if both FR, prefer later overlay (caller order)
    if (ns > ps || (ns >= 2 && ns >= ps)) {
      overlayLog.push({ k, meta, action: 'replace', from: prev, to: v, ps, ns });
      merged[k] = v;
    }
  }
}

function extractKvFromString(s) {
  const o = {};
  const re = /"([A-Z][A-Z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(s))) {
    o[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return o;
}

function extractFrBlock(text) {
  const o = {};
  const re = /\bfr\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length && j < open + 30000; j++) {
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
  // single string maps
  if (/GALAXIES_NONE_VISIBLE|gal-none/.test(text)) {
    const sm = text.match(/\bfr\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    if (sm) o.GALAXIES_NONE_VISIBLE = sm[2].replace(/\\'/g, "'");
  }
  return o;
}

function parseLines(f) {
  return fs
    .readFileSync(f, 'utf8')
    .split(/\n/)
    .map((l, i) => {
      if (!l.trim()) return null;
      try {
        return { i: i + 1, o: JSON.parse(l) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toolUses(entry) {
  const c = entry.o.message && entry.o.message.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter((x) => x.type === 'tool_use')
    .map((x) => ({ line: entry.i, name: x.name, input: x.input || {} }));
}

function processFile(file) {
  for (const entry of parseLines(file)) {
    for (const tu of toolUses(entry)) {
      const p = String(tu.input.path || '');
      const meta = path.basename(file) + ':L' + tu.line + ':' + tu.name;

      if (tu.name === 'Write') {
        const contents = String(tu.input.contents || '');
        if (
          contents.includes('fr:') ||
          /LOOK_|ISS_|VISIBLE_|CAL_MOUSE|GALAX|AUTO_|TILT_|SATELLITES|PHONE_TILT|TURN_OK/.test(
            contents
          )
        ) {
          const block = extractFrBlock(contents);
          if (Object.keys(block).length) overlay(block, meta + ':fr_block');
        }
        // Python FR blocks with JSON-like lines
        if (
          /FR_BLOCK|fr_keys|ISS_KEYS_FR|LOOK.*fr|fr\.json/.test(contents) ||
          (p.includes('fr') && contents.includes('"TITLE"'))
        ) {
          const kv = extractKvFromString(contents);
          const frkv = {};
          for (const [k, v] of Object.entries(kv)) {
            if (frScore(v) > 0) frkv[k] = v;
          }
          if (Object.keys(frkv).length) overlay(frkv, meta + ':kv_fr');
        }
        // Special: python files with ISS_KEYS_FR or similar triple-quoted
        const frIss = contents.match(
          /ISS_KEYS_FR\s*=\s*'''([\s\S]*?)'''|ISS_KEYS_FR\s*=\s*"""([\s\S]*?)"""/
        );
        if (frIss) {
          const kv = extractKvFromString(frIss[1] || frIss[2]);
          overlay(kv, meta + ':ISS_KEYS_FR');
        }
        const frLook = contents.match(
          /FR_BLOCK\s*=\s*\(([\s\S]*?)\)\s*\n|LOOK_FR|FR_LOOK/
        );
        if (contents.includes('LOOK_TITLE') && contents.includes('Où regarder')) {
          const kv = extractKvFromString(contents);
          const frkv = {};
          for (const [k, v] of Object.entries(kv)) {
            if (frScore(v) > 0 || k.startsWith('LOOK_')) frkv[k] = v;
          }
          overlay(frkv, meta + ':look');
        }
      }

      if (tu.name === 'StrReplace' && p.includes('fr.json')) {
        const ns = String(tu.input.new_string || '');
        const kv = extractKvFromString(ns);
        const frkv = {};
        for (const [k, v] of Object.entries(kv)) {
          if (
            frScore(v) > 0 ||
            /^(CAL_|LOOK_|ISS_|VISIBLE_|SATELLITES|BODY_|SUBTITLE|GALAX|STAR_|AUTO_|TILT_|TURN_|PHONE_|DEVICE_|KIND_|PLANETS|STARS_|FACING)/.test(
              k
            )
          ) {
            frkv[k] = v;
          }
        }
        if (Object.keys(frkv).length) overlay(frkv, meta + ':strreplace');
      }

      if (tu.name === 'Shell') {
        const cmd = String(tu.input.command || '');
        const block = extractFrBlock(cmd);
        if (Object.keys(block).length) overlay(block, meta + ':shell_fr');
        if (/fr\.json/.test(cmd)) {
          const kv = extractKvFromString(cmd);
          const frkv = {};
          for (const [k, v] of Object.entries(kv)) {
            if (frScore(v) > 0) frkv[k] = v;
          }
          if (Object.keys(frkv).length) overlay(frkv, meta + ':shell_kv');
        }
        // powershell $new = '...' French subtitle
        const mNew = cmd.match(
          /\$new\s*=\s*'((?:\\'|[^'])*)'|\$new\s*=\s*"((?:\\"|[^"])*)"/
        );
        if (mNew && /ISS|planète|étoile/.test(mNew[1] || mNew[2] || '')) {
          overlay(
            { SUBTITLE: (mNew[1] || mNew[2]).replace(/\\'/g, "'") },
            meta + ':ps_new'
          );
        }
      }
    }
  }
}

processFile(e0);
processFile(t7);

// Merge recovered_merged (already FR-prioritized)
overlay(
  JSON.parse(fs.readFileSync(path.join(out, 'recovered_merged.json'), 'utf8')),
  'recovered_merged'
);

// Explicit FR patches known from transcript quotes if still missing mouse keys
// Extract CAL_MOUSE French from 7ca L24 StrReplace new_string specifically
for (const entry of parseLines(t7)) {
  for (const tu of toolUses(entry)) {
    if (tu.name !== 'StrReplace') continue;
    if (!String(tu.input.path || '').includes('fr.json')) continue;
    const ns = String(tu.input.new_string || '');
    if (ns.includes('CAL_MOUSE') || ns.includes('CAL_OPEN') || ns.includes('CAL_MODAL')) {
      overlay(extractKvFromString(ns), 't7:L' + tu.line + ':cal_patch');
    }
  }
}

// Extract LOOK French from e0ea L146 StrReplace on fr.json
for (const entry of parseLines(e0)) {
  for (const tu of toolUses(entry)) {
    if (tu.name !== 'StrReplace') continue;
    if (!String(tu.input.path || '').includes('fr.json')) continue;
    const ns = String(tu.input.new_string || '');
    if (ns.includes('LOOK_TITLE') || ns.includes('SATELLITES_TITLE') || ns.includes('VISIBLE_ONLY')) {
      overlay(extractKvFromString(ns), 'e0:L' + tu.line + ':fr_patch');
    }
  }
}

// Pull ISS_KEYS_FR from python patch write
for (const entry of parseLines(e0)) {
  for (const tu of toolUses(entry)) {
    if (tu.name !== 'Write') continue;
    const contents = String(tu.input.contents || '');
    if (!contents.includes('ISS_KEYS_FR') && !contents.includes('_patch_look')) continue;
    // FR look block in python: lines with French
    if (contents.includes('Où regarder') || contents.includes('LOOK_TITLE')) {
      // match FR_BLOCK = ( '    "LOOK... \n' ... )
      const blocks = contents.match(/'    \\"[A-Z_]+\\": \\"[^']*\\",\\n'/g);
      // better: unescape python string concatenation
      const parts = [...contents.matchAll(/'([^']*LOOK_[^']*)'|\"([^\"]*LOOK_[^\"]*)\"/g)];
      const kv = extractKvFromString(contents.replace(/\\"/g, '"').replace(/\\n/g, '\n'));
      const frkv = {};
      for (const [k, v] of Object.entries(kv)) {
        if (k.startsWith('LOOK_') || frScore(v) > 0) frkv[k] = v;
      }
      overlay(frkv, 'e0:L' + tu.line + ':py_look_iss');
    }
    if (contents.includes('ISS_KEYS_FR')) {
      const m = contents.match(/ISS_KEYS_FR\s*=\s*'''([\s\S]*?)'''/);
      if (m) overlay(extractKvFromString(m[1]), 'e0:ISS_KEYS_FR');
    }
  }
}

fs.writeFileSync(
  path.join(out, 'ASTRO_COMPASS_FR_FINAL.json'),
  JSON.stringify(merged, null, 2)
);
fs.writeFileSync(path.join(out, 'overlay_log.json'), JSON.stringify(overlayLog, null, 2));

// Also extract EN for comparison of missing keys
let enKeys = [];
for (const entry of parseLines(e0)) {
  for (const tu of toolUses(entry)) {
    if (
      tu.name === 'Write' &&
      String(tu.input.path || '').includes('_i18n_en.json')
    ) {
      const en = JSON.parse(tu.input.contents);
      fs.writeFileSync(
        path.join(out, '_i18n_en_from_transcript.json'),
        JSON.stringify(en, null, 2)
      );
      enKeys = Object.keys(en);
    }
  }
}

const missingVsEnBase = enKeys.filter((k) => !merged[k]);
const allMergedKeys = Object.keys(merged).sort();

console.log('final keys', allMergedKeys.length);
console.log('missing vs en base', missingVsEnBase);
console.log(
  'CAL_MOUSE',
  allMergedKeys.filter((k) => k.includes('MOUSE'))
);
console.log(
  'LOOK',
  allMergedKeys.filter((k) => k.startsWith('LOOK_'))
);
console.log(
  'ISS/SAT',
  allMergedKeys.filter(
    (k) => k.startsWith('ISS_') || k === 'BODY_ISS' || k === 'SATELLITES_TITLE'
  )
);
console.log(
  'AUTO count',
  allMergedKeys.filter((k) => k.startsWith('AUTO_')).length
);
console.log('TITLE', merged.TITLE);
console.log('LOOK_TITLE', merged.LOOK_TITLE);
console.log('TILT_OK', merged.TILT_OK);
console.log('CAL_MODAL_TITLE', merged.CAL_MODAL_TITLE);
console.log('AUTO_MODAL_TITLE', merged.AUTO_MODAL_TITLE);
console.log('SATELLITES_TITLE', merged.SATELLITES_TITLE);
console.log('CAL_OPEN', merged.CAL_OPEN);
console.log('CAL_MOUSE_CONFIRM', merged.CAL_MOUSE_CONFIRM);
console.log('SUBTITLE', merged.SUBTITLE);
console.log('FACING', merged.FACING);
console.log('overlay ops', overlayLog.length);
