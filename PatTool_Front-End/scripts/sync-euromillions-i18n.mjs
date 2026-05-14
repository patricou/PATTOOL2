/**
 * Keeps EUROMILLIONS i18n aligned with en.json (all keys).
 * UI strings per locale live in euromillions-native-src/{lang}.mjs (94 keys).
 * Long assistant specs stay English for LLM consistency (same keys as en.json).
 *
 * Run from repo: node PatTool_Front-End/scripts/sync-euromillions-i18n.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const i18nDir = path.join(__dirname, '../src/assets/i18n');
const nativeSrcDir = path.join(__dirname, 'euromillions-native-src');

const LANGS = ['de', 'es', 'it', 'ru', 'el', 'ar', 'he', 'in', 'jp', 'cn'];

const KEEP_ENGLISH = new Set([
  'METHOD_CHI2_GOF_UNIFORM_AI_SPEC',
  'METHOD_ENTROPY_NORMALIZED_AI_SPEC',
  'METHOD_GAP_RECURRENCE_AI_SPEC',
  'METHOD_SUM_CORRELATION_AI_SPEC',
  'METHOD_MONTE_CARLO_MAXFREQ_AI_SPEC',
  'AI_PROMPT_FROM_SCRATCH',
  'AI_PROMPT_MULTI_SYNTHESIS',
  'AI_STATS_PAYLOAD_INTRO',
  'AI_SELECTED_METHOD_HINT',
  'AI_MULTI_METHOD_HINT',
  'AI_MULTI_SYNTHESIS_HINT',
  'AI_MESSAGE_1'
]);

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const enEu = loadJson(path.join(i18nDir, 'en.json')).EUROMILLIONS;

async function loadNative(lang) {
  const modPath = path.join(nativeSrcDir, `${lang}.mjs`);
  const mod = await import(pathToFileURL(modPath).href);
  return mod.default;
}

for (const lang of LANGS) {
  const filePath = path.join(i18nDir, `${lang}.json`);
  const data = loadJson(filePath);
  const prev = data.EUROMILLIONS || {};
  const merged = { ...enEu, ...prev };
  const langOv = await loadNative(lang);

  const expectedUiKeys = Object.keys(enEu).filter((k) => !KEEP_ENGLISH.has(k));
  const missing = expectedUiKeys.filter((k) => langOv[k] === undefined || langOv[k] === '');
  if (missing.length) {
    throw new Error(`${lang}: euromillions-native-src/${lang}.mjs missing keys: ${missing.slice(0, 12).join(', ')}`);
  }

  for (const key of Object.keys(langOv)) {
    if (KEEP_ENGLISH.has(key)) {
      continue;
    }
    merged[key] = langOv[key];
  }

  for (const key of KEEP_ENGLISH) {
    merged[key] = enEu[key];
  }

  data.EUROMILLIONS = merged;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf8');
}

console.log('EUROMILLIONS synced for:', LANGS.join(', '));
