/**
 * Generates saint-of-day JSON assets:
 * - assets/saints/traditional/fr.json  (French popular calendar)
 * - assets/saints/liturgical/{lang}.json (Roman liturgical calendar, localized)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Romcal } from 'romcal';
import * as gr from '@romcal/calendar.general-roman';
import * as frCal from '@romcal/calendar.france';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'src', 'assets', 'saints');

const SKIP_RE =
    /\b(january|janvier|february|février|march|mars|april|avril|may|mai|june|juin|july|juillet|august|août|september|septembre|october|octobre|november|novembre|december|décembre|\d{1,2}\s*(janvier|january|décembre|december))\b|^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|semaine|week|ordinary time|temps ordinaire|advent|avent|carême|lent|pâques|easter|octave|dimanche|sunday|premier|deuxième|troisième|quatrième|cinquième|sixième|seventh|huitième|neuvième|dixième|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|treizième|quatorzième|quinzième|seizième|dix-sept|dix-huit|dix-neuf|vingt|trente|trente et un|thirty|after ash|après les cendres|mercredi des cendres|ash wednesday|rameaux|palm|passion|holy week|semaine sainte|vendredi saint|good friday|jeudi saint|mardi saint|lundi saint|mercredi saint|samedi saint|samedi de|samedi du|lundi de|mardi de|mercredi de|jeudi de|vendredi de|lundi du|mardi du|mercredi du|jeudi du|vendredi du|monday of|tuesday of|wednesday of|thursday of|friday of|saturday of|day in the|jour dans|jour de l|day of the|dédicace des églises dont|dedication of the/i;

function shorten(name) {
    if (name.length <= 48) {
        return name.trim();
    }
    const m = name.match(
        /^(Saint|Sainte|Saints|Saintes|San|Sant|Santa|Santo|Blessed|Bienheureux|Bienheureuse|Our Lady|Notre-Dame|Holy|La Sainte|The Most Holy|Solemnity of)[^,]+/i
    );
    return (m ? m[0] : name.split(',')[0]).trim();
}

function pickLiturgicalName(celebrations) {
    if (!celebrations?.length) {
        return '';
    }
    const candidates = celebrations.filter(c => c.rank !== 'WEEKDAY' && !SKIP_RE.test(c.name || ''));
    if (!candidates.length) {
        return '';
    }
    const ranked = [...candidates].sort((a, b) => {
        const score = c => {
            let s = 0;
            if (c.martyrology?.length) s += 30;
            if (c.rank === 'SOLEMNITY') s += 80;
            if (c.rank === 'FEAST') s += 60;
            if (c.rank === 'MEMORIAL') s += 40;
            if (c.rank === 'OPTIONAL_MEMORIAL') s += 20;
            return s;
        };
        return score(b) - score(a);
    });
    return shorten(ranked[0].name || '');
}

const LITURGICAL_LANG = {
    fr: frCal.France_Fr,
    en: gr.GeneralRoman_EnGb,
    de: gr.GeneralRoman_De,
    es: gr.GeneralRoman_Es,
    it: gr.GeneralRoman_It,
    ar: gr.GeneralRoman_En,
    cn: gr.GeneralRoman_En,
    el: gr.GeneralRoman_En,
    he: gr.GeneralRoman_En,
    in: gr.GeneralRoman_En,
    jp: gr.GeneralRoman_En,
    ru: gr.GeneralRoman_En
};

async function generateLiturgical(lang, bundle) {
    const romcal = new Romcal({ localizedCalendar: bundle });
    const cal = await romcal.generateCalendar(2024);
    const out = {};
    for (const [dateKey, items] of Object.entries(cal)) {
        const m = dateKey.match(/^\d{4}-(\d{2})-(\d{2})$/);
        if (!m) continue;
        out[`${m[1]}-${m[2]}`] = pickLiturgicalName(items);
    }
    if (!out['02-29']) {
        out['02-29'] = out['02-28'] || '';
    }
    const dir = path.join(root, 'liturgical');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(out));
    const filled = Object.values(out).filter(Boolean).length;
    console.log(`liturgical/${lang}.json — ${filled}/${Object.keys(out).length} days`);
}

function migrateTraditional() {
    const legacy = path.join(root, 'fr.json');
    const dir = path.join(root, 'traditional');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'fr.json');
    if (fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, target);
        console.log('traditional/fr.json — migrated from legacy fr.json');
    }
}

async function main() {
    migrateTraditional();
    for (const [lang, bundle] of Object.entries(LITURGICAL_LANG)) {
        await generateLiturgical(lang, bundle);
    }
    // Remove legacy flat files if present
    for (const lang of Object.keys(LITURGICAL_LANG)) {
        const legacy = path.join(root, `${lang}.json`);
        if (fs.existsSync(legacy)) {
            fs.unlinkSync(legacy);
            console.log(`removed legacy ${lang}.json`);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
