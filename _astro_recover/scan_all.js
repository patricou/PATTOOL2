const fs = require('fs');
const path = require('path');

const root =
  'C:/Users/desch/.cursor/projects/c-Dev-PATTOOL2/agent-transcripts';

function walk(d, a = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, a);
    else if (e.name.endsWith('.jsonl')) a.push(p);
  }
  return a;
}

const files = walk(root);
const hits = [];

for (const f of files) {
  const data = fs.readFileSync(f, 'utf8');
  if (!data.includes('ASTRO_COMPASS')) continue;
  const frHints = (
    data.match(
      /Calibrage du Nord|Recalage du Nord|Boussole|Aucune étoile|Inclinaison|Face à la cible|Auto-détection|SATELLITES_TITLE|LOOK_TITLE|TILT_OK|Étoiles brillantes|Caler le Nord/g
    ) || []
  ).length;
  const hasBlock =
    data.includes('"ASTRO_COMPASS": {') || data.includes('"ASTRO_COMPASS":{');
  const hasSat = data.includes('SATELLITES_TITLE');
  const hasLook = data.includes('LOOK_TITLE');
  const hasCalNeeded = data.includes('CAL_NEEDED');
  const size = fs.statSync(f).size;
  if (frHints > 0 || hasBlock || hasSat || hasLook) {
    hits.push({
      file: f.slice(root.length),
      size,
      frHints,
      hasBlock,
      hasSat,
      hasLook,
      hasCalNeeded,
    });
  }
}

hits.sort((a, b) => b.frHints - a.frHints || b.size - a.size);
fs.writeFileSync(
  'C:/Dev/PATTOOL2/_astro_recover/all_transcript_hits.json',
  JSON.stringify(hits, null, 2)
);
console.log('hits', hits.length);
console.log(JSON.stringify(hits.slice(0, 50), null, 2));
