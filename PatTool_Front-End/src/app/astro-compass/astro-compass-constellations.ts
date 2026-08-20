import { ASTRO_BRIGHT_STARS, AstroStarOption } from './astro-compass-catalog';

/** IAU constellation aimed via the geometric centre (J2000 RA/Dec). */
export interface AstroConstellationOption {
  id: string;
  kind: 'constellation';
  /** IAU 3-letter abbreviation. */
  iau: string;
  /** Latin / international name. */
  name: string;
  /** French common name. */
  nameFr: string;
  aliases: string[];
  /** J2000 right ascension of the constellation centre, hours [0, 24). */
  raHours: number;
  /** J2000 declination of the constellation centre, degrees. */
  decDeg: number;
  /** Apparent magnitude of the brightest star (visibility / mag filter). */
  mag: number;
  wikiFr: string;
  wikiEn: string;
  iconClass: string;
  color: string;
}

const ICON = 'fa fa-star-o';
const COLOR = '#d8b4fe';

function c(
  id: string,
  iau: string,
  name: string,
  nameFr: string,
  aliases: string[],
  raHours: number,
  decDeg: number,
  mag: number,
  wikiFr: string,
  wikiEn: string
): AstroConstellationOption {
  return {
    id,
    kind: 'constellation',
    iau,
    name,
    nameFr,
    aliases,
    raHours,
    decDeg,
    mag,
    wikiFr,
    wikiEn,
    iconClass: ICON,
    color: COLOR
  };
}

/**
 * The 88 IAU constellations. Centres are approximate J2000 barycentres;
 * magnitude is that of the brightest star (for the visible / mag filters).
 */
export const ASTRO_CONSTELLATIONS: ReadonlyArray<AstroConstellationOption> = [
  c('and', 'And', 'Andromeda', 'Andromède', ['andromeda'], 0.807, 37.43, 2.06, 'Andromède_(constellation)', 'Andromeda_(constellation)'),
  c('ant', 'Ant', 'Antlia', 'Machine pneumatique', ['antlia', 'pompe'], 10.273, -32.48, 4.25, 'Machine_pneumatique', 'Antlia'),
  c('aps', 'Aps', 'Apus', 'Oiseau de paradis', ['apus', 'bird of paradise'], 16.145, -75.30, 3.83, 'Oiseau_de_paradis_(constellation)', 'Apus_(constellation)'),
  c('aqr', 'Aqr', 'Aquarius', 'Verseau', ['aquarius', 'water bearer'], 22.690, -10.19, 2.91, 'Verseau', 'Aquarius_(constellation)'),
  c('aql', 'Aql', 'Aquila', 'Aigle', ['aquila', 'eagle'], 19.667, 3.41, 0.76, 'Aigle_(constellation)', 'Aquila_(constellation)'),
  c('ara', 'Ara', 'Ara', 'Autel', ['altar'], 17.375, -56.59, 2.85, 'Autel_(constellation)', 'Ara_(constellation)'),
  c('ari', 'Ari', 'Aries', 'Bélier', ['aries', 'ram'], 2.636, 20.79, 2.00, 'Bélier_(constellation)', 'Aries_(constellation)'),
  c('aur', 'Aur', 'Auriga', 'Cocher', ['auriga', 'charioteer'], 6.073, 42.03, 0.08, 'Cocher_(constellation)', 'Auriga_(constellation)'),
  c('boo', 'Boo', 'Boötes', 'Bouvier', ['bootes', 'bootes', 'herdsman'], 14.710, 31.20, -0.05, 'Bouvier_(constellation)', 'Boötes'),
  c('cae', 'Cae', 'Caelum', 'Burin', ['caelum', 'chisel'], 4.704, -37.88, 4.45, 'Burin_(constellation)', 'Caelum'),
  c('cam', 'Cam', 'Camelopardalis', 'Girafe', ['giraffe', 'cameleopard'], 5.839, 69.08, 4.26, 'Girafe_(constellation)', 'Camelopardalis'),
  c('cnc', 'Cnc', 'Cancer', 'Cancer', ['crabe', 'crab'], 8.649, 19.81, 3.53, 'Cancer_(constellation)', 'Cancer_(constellation)'),
  c('cvn', 'CVn', 'Canes Venatici', 'Chiens de chasse', ['chiens', 'hunting dogs'], 13.200, 40.10, 2.90, 'Chiens_de_chasse', 'Canes_Venatici'),
  c('cma', 'CMa', 'Canis Major', 'Grand Chien', ['grand chien', 'greater dog'], 6.829, -22.14, -1.46, 'Grand_Chien', 'Canis_Major'),
  c('cmi', 'CMi', 'Canis Minor', 'Petit Chien', ['petit chien', 'lesser dog'], 7.613, 6.43, 0.34, 'Petit_Chien', 'Canis_Minor'),
  c('cap', 'Cap', 'Capricornus', 'Capricorne', ['capricorn', 'goat'], 21.049, -18.01, 2.85, 'Capricorne_(constellation)', 'Capricornus'),
  c('car', 'Car', 'Carina', 'Carène', ['keel'], 8.695, -63.22, -0.74, 'Carène_(constellation)', 'Carina_(constellation)'),
  c('cas', 'Cas', 'Cassiopeia', 'Cassiopée', ['cassiopeia', 'w'], 1.319, 62.19, 2.15, 'Cassiopée_(constellation)', 'Cassiopeia_(constellation)'),
  c('cen', 'Cen', 'Centaurus', 'Centaure', ['centaur'], 13.070, -47.35, -0.27, 'Centaure_(constellation)', 'Centaurus'),
  c('cep', 'Cep', 'Cepheus', 'Céphée', ['cepheus'], 22.000, 71.00, 2.45, 'Céphée_(constellation)', 'Cepheus_(constellation)'),
  c('cet', 'Cet', 'Cetus', 'Baleine', ['cetus', 'whale'], 1.669, -7.18, 2.00, 'Baleine_(constellation)', 'Cetus_(constellation)'),
  c('cha', 'Cha', 'Chamaeleon', 'Caméléon', ['chameleon'], 10.692, -79.21, 4.05, 'Caméléon_(constellation)', 'Chamaeleon'),
  c('cir', 'Cir', 'Circinus', 'Compas', ['circinus', 'compass'], 14.956, -63.03, 3.19, 'Compas_(constellation)', 'Circinus'),
  c('col', 'Col', 'Columba', 'Colombe', ['dove', 'colombe'], 5.862, -35.09, 2.65, 'Colombe_(constellation)', 'Columba_(constellation)'),
  c('com', 'Com', 'Coma Berenices', 'Chevelure de Bérénice', ['berenice', 'coma'], 12.787, 23.31, 4.26, 'Chevelure_de_Bérénice', 'Coma_Berenices'),
  c('cra', 'CrA', 'Corona Australis', 'Couronne australe', ['southern crown'], 18.646, -41.15, 4.11, 'Couronne_australe', 'Corona_Australis'),
  c('crb', 'CrB', 'Corona Borealis', 'Couronne boréale', ['northern crown'], 15.845, 32.62, 2.23, 'Couronne_boréale', 'Corona_Borealis'),
  c('crv', 'Crv', 'Corvus', 'Corbeau', ['crow', 'raven'], 12.454, -18.43, 2.59, 'Corbeau_(constellation)', 'Corvus_(constellation)'),
  c('crt', 'Crt', 'Crater', 'Coupe', ['cup', 'crater'], 11.396, -15.93, 3.56, 'Coupe_(constellation)', 'Crater_(constellation)'),
  c('cru', 'Cru', 'Crux', 'Croix du Sud', ['southern cross', 'crux'], 12.449, -60.19, 0.77, 'Croix_du_Sud', 'Crux'),
  c('cyg', 'Cyg', 'Cygnus', 'Cygne', ['swan', 'northern cross'], 20.588, 44.54, 1.25, 'Cygne_(constellation)', 'Cygnus_(constellation)'),
  c('del', 'Del', 'Delphinus', 'Dauphin', ['dolphin'], 20.693, 11.67, 3.64, 'Dauphin_(constellation)', 'Delphinus'),
  c('dor', 'Dor', 'Dorado', 'Dorade', ['swordfish', 'goldfish'], 5.242, -59.39, 3.27, 'Dorade_(constellation)', 'Dorado'),
  c('dra', 'Dra', 'Draco', 'Dragon', ['draco', 'dragon'], 17.000, 65.00, 2.24, 'Dragon_(constellation)', 'Draco_(constellation)'),
  c('equ', 'Equ', 'Equuleus', 'Petit Cheval', ['little horse', 'foal'], 21.187, 7.76, 3.92, 'Petit_Cheval', 'Equuleus'),
  c('eri', 'Eri', 'Eridanus', 'Éridan', ['eridanus', 'river'], 3.300, -28.99, 0.46, 'Éridan_(constellation)', 'Eridanus_(constellation)'),
  c('for', 'For', 'Fornax', 'Fourneau', ['furnace'], 2.798, -31.62, 3.80, 'Fourneau_(constellation)', 'Fornax_(constellation)'),
  c('gem', 'Gem', 'Gemini', 'Gémeaux', ['twins', 'gemini'], 7.073, 22.60, 1.14, 'Gémeaux', 'Gemini_(constellation)'),
  c('gru', 'Gru', 'Grus', 'Grue', ['crane'], 22.456, -46.35, 1.74, 'Grue_(constellation)', 'Grus_(constellation)'),
  c('her', 'Her', 'Hercules', 'Hercule', ['hercules'], 17.385, 27.50, 2.78, 'Hercule_(constellation)', 'Hercules_(constellation)'),
  c('hor', 'Hor', 'Horologium', 'Horloge', ['clock', 'pendulum'], 3.276, -53.24, 3.85, 'Horloge_(constellation)', 'Horologium'),
  c('hya', 'Hya', 'Hydra', 'Hydre', ['hydra', 'water snake'], 11.612, -14.52, 1.98, 'Hydre_(constellation)', 'Hydra_(constellation)'),
  c('hyi', 'Hyi', 'Hydrus', 'Hydre mâle', ['male hydra', 'water snake'], 2.344, -69.80, 2.82, 'Hydre_mâle', 'Hydrus'),
  c('ind', 'Ind', 'Indus', 'Indien', ['indian'], 21.972, -59.71, 3.11, 'Indien_(constellation)', 'Indus_(constellation)'),
  c('lac', 'Lac', 'Lacerta', 'Lézard', ['lizard'], 22.521, 46.04, 3.77, 'Lézard_(constellation)', 'Lacerta'),
  c('leo', 'Leo', 'Leo', 'Lion', ['lion', 'leo'], 10.667, 13.14, 1.35, 'Lion_(constellation)', 'Leo_(constellation)'),
  c('lmi', 'LMi', 'Leo Minor', 'Petit Lion', ['lesser lion'], 10.245, 32.14, 3.79, 'Petit_Lion', 'Leo_Minor'),
  c('lep', 'Lep', 'Lepus', 'Lièvre', ['hare', 'lepus'], 5.565, -19.05, 2.58, 'Lièvre_(constellation)', 'Lepus_(constellation)'),
  c('lib', 'Lib', 'Libra', 'Balance', ['scales', 'libra'], 15.192, -15.24, 2.61, 'Balance_(constellation)', 'Libra_(constellation)'),
  c('lup', 'Lup', 'Lupus', 'Loup', ['wolf', 'lupus'], 15.221, -42.71, 2.30, 'Loup_(constellation)', 'Lupus_(constellation)'),
  c('lyn', 'Lyn', 'Lynx', 'Lynx', ['lynx'], 8.000, 47.07, 3.14, 'Lynx_(constellation)', 'Lynx_(constellation)'),
  c('lyr', 'Lyr', 'Lyra', 'Lyre', ['lyre', 'harp'], 18.870, 36.70, 0.03, 'Lyre_(constellation)', 'Lyra'),
  c('men', 'Men', 'Mensa', 'Table', ['table mountain'], 5.415, -77.52, 5.09, 'Table_(constellation)', 'Mensa_(constellation)'),
  c('mic', 'Mic', 'Microscopium', 'Microscope', ['microscope'], 20.964, -36.27, 4.67, 'Microscope_(constellation)', 'Microscopium'),
  c('mon', 'Mon', 'Monoceros', 'Licorne', ['unicorn'], 7.061, -0.36, 3.76, 'Licorne_(constellation)', 'Monoceros'),
  c('mus', 'Mus', 'Musca', 'Mouche', ['fly', 'musca'], 12.587, -70.16, 2.69, 'Mouche_(constellation)', 'Musca'),
  c('nor', 'Nor', 'Norma', 'Règle', ['level', 'norma', 'square'], 16.054, -51.35, 4.01, 'Règle_(constellation)', 'Norma_(constellation)'),
  c('oct', 'Oct', 'Octans', 'Octant', ['octant', 'south pole'], 22.000, -82.00, 3.76, 'Octant_(constellation)', 'Octans'),
  c('oph', 'Oph', 'Ophiuchus', 'Serpentaire', ['serpent bearer', 'ophiuchus'], 17.394, -7.91, 2.08, 'Ophiuchus', 'Ophiuchus'),
  c('ori', 'Ori', 'Orion', 'Orion', ['hunter', 'chasseur'], 5.603, 5.57, 0.13, 'Orion_(constellation)', 'Orion_(constellation)'),
  c('pav', 'Pav', 'Pavo', 'Paon', ['peacock'], 19.612, -65.78, 1.94, 'Paon_(constellation)', 'Pavo_(constellation)'),
  c('peg', 'Peg', 'Pegasus', 'Pégase', ['pegasus', 'winged horse'], 22.697, 19.47, 2.38, 'Pégase_(constellation)', 'Pegasus_(constellation)'),
  c('per', 'Per', 'Perseus', 'Persée', ['perseus'], 3.292, 45.00, 1.79, 'Persée_(constellation)', 'Perseus_(constellation)'),
  c('phe', 'Phe', 'Phoenix', 'Phénix', ['phoenix'], 0.935, -44.76, 2.39, 'Phénix_(constellation)', 'Phoenix_(constellation)'),
  c('pic', 'Pic', 'Pictor', 'Peintre', ['easel', 'painter'], 5.708, -53.47, 3.27, 'Peintre_(constellation)', 'Pictor'),
  c('psc', 'Psc', 'Pisces', 'Poissons', ['fishes', 'pisces'], 0.435, 13.58, 3.62, 'Poissons_(constellation)', 'Pisces_(constellation)'),
  c('psa', 'PsA', 'Piscis Austrinus', 'Poisson austral', ['southern fish'], 22.284, -30.64, 1.16, 'Poisson_austral', 'Piscis_Austrinus'),
  c('pup', 'Pup', 'Puppis', 'Poupe', ['poop deck', 'stern'], 7.257, -31.18, 2.21, 'Poupe_(constellation)', 'Puppis'),
  c('pyx', 'Pyx', 'Pyxis', 'Boussole', ['compass', 'mariner compass'], 8.952, -27.35, 3.68, 'Boussole_(constellation)', 'Pyxis'),
  c('ret', 'Ret', 'Reticulum', 'Réticule', ['net', 'reticle'], 3.921, -59.83, 3.33, 'Réticule_(constellation)', 'Reticulum'),
  c('sge', 'Sge', 'Sagitta', 'Flèche', ['arrow', 'sagitta'], 19.650, 18.66, 3.51, 'Flèche_(constellation)', 'Sagitta'),
  c('sgr', 'Sgr', 'Sagittarius', 'Sagittaire', ['archer', 'teapot'], 19.096, -28.48, 1.79, 'Sagittaire_(constellation)', 'Sagittarius_(constellation)'),
  c('sco', 'Sco', 'Scorpius', 'Scorpion', ['scorpio', 'scorpion'], 16.890, -34.20, 0.96, 'Scorpion_(constellation)', 'Scorpius'),
  c('scl', 'Scl', 'Sculptor', 'Sculpteur', ['sculptor'], 0.435, -32.09, 4.31, 'Sculpteur_(constellation)', 'Sculptor_(constellation)'),
  c('sct', 'Sct', 'Scutum', 'Écu de Sobieski', ['shield', 'scutum'], 18.673, -9.89, 3.85, 'Écu_de_Sobieski', 'Scutum_(constellation)'),
  c('ser', 'Ser', 'Serpens', 'Serpent', ['serpent', 'snake'], 16.000, 7.00, 2.63, 'Serpent_(constellation)', 'Serpens'),
  c('sex', 'Sex', 'Sextans', 'Sextant', ['sextant'], 10.271, -2.61, 4.49, 'Sextant_(constellation)', 'Sextans'),
  c('tau', 'Tau', 'Taurus', 'Taureau', ['bull', 'taurus'], 4.702, 14.88, 0.86, 'Taureau_(constellation)', 'Taurus_(constellation)'),
  c('tel', 'Tel', 'Telescopium', 'Télescope', ['telescope'], 19.325, -51.05, 3.51, 'Télescope_(constellation)', 'Telescopium'),
  c('tri', 'Tri', 'Triangulum', 'Triangle', ['triangle'], 2.188, 31.48, 3.00, 'Triangle_(constellation)', 'Triangulum'),
  c('tra', 'TrA', 'Triangulum Australe', 'Triangle austral', ['southern triangle'], 16.082, -65.39, 1.91, 'Triangle_austral', 'Triangulum_Australe'),
  c('tuc', 'Tuc', 'Tucana', 'Toucan', ['toucan'], 23.777, -65.82, 2.86, 'Toucan_(constellation)', 'Tucana'),
  c('uma', 'UMa', 'Ursa Major', 'Grande Ourse', ['great bear', 'big dipper', 'grande ourse', 'cassrole', 'casserole'], 11.312, 50.72, 1.76, 'Grande_Ourse', 'Ursa_Major'),
  c('umi', 'UMi', 'Ursa Minor', 'Petite Ourse', ['little bear', 'little dipper', 'petite ourse'], 15.000, 77.70, 1.98, 'Petite_Ourse', 'Ursa_Minor'),
  c('vel', 'Vel', 'Vela', 'Voiles', ['sails', 'vela'], 9.512, -47.17, 1.78, 'Voiles_(constellation)', 'Vela_(constellation)'),
  c('vir', 'Vir', 'Virgo', 'Vierge', ['virgin', 'virgo'], 13.406, -4.16, 0.97, 'Vierge_(constellation)', 'Virgo_(constellation)'),
  c('vol', 'Vol', 'Volans', 'Poisson volant', ['flying fish'], 7.795, -68.80, 3.62, 'Poisson_volant', 'Volans'),
  c('vul', 'Vul', 'Vulpecula', 'Petit Renard', ['little fox', 'fox'], 20.231, 24.44, 4.44, 'Petit_Renard', 'Vulpecula')
];

/** Stick-figure segments (catalog star ids) for well-known asterisms. */
export const CONSTELLATION_STICK_LINES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  uma: [
    ['dubhe', 'merak'],
    ['merak', 'phecda'],
    ['phecda', 'megrez'],
    ['megrez', 'alioth'],
    ['alioth', 'mizar'],
    ['mizar', 'alkaid'],
    ['megrez', 'dubhe']
  ],
  umi: [['polaris', 'kochab']],
  ori: [
    ['betelgeuse', 'bellatrix'],
    ['bellatrix', 'mintaka'],
    ['mintaka', 'alnilam'],
    ['alnilam', 'alnitak'],
    ['alnitak', 'betelgeuse'],
    ['alnitak', 'saiph'],
    ['saiph', 'rigel'],
    ['rigel', 'mintaka']
  ],
  cas: [
    ['caph', 'schedar'],
    ['schedar', 'navi']
  ],
  cyg: [['deneb', 'sadr']],
  leo: [['regulus', 'denebola']],
  tau: [['aldebaran', 'elnath']],
  sco: [['antares', 'shaula']],
  cru: [
    ['acrux', 'gacrux'],
    ['mimosa', 'acrux']
  ],
  cma: [
    ['sirius', 'adhara'],
    ['sirius', 'wezen']
  ],
  gem: [['castor', 'pollux']],
  and: [
    ['alpheratz', 'mirach'],
    ['mirach', 'almach']
  ],
  peg: [
    ['markab', 'scheat'],
    ['markab', 'enif']
  ],
  per: [['mirfak', 'algol']],
  lyr: [],
  aql: [],
  crb: []
};

export function findConstellationById(id: string): AstroConstellationOption | undefined {
  const key = (id || '').trim().toLowerCase();
  return ASTRO_CONSTELLATIONS.find((c) => c.id === key);
}

export function constellationMemberStars(iau: string): AstroStarOption[] {
  const code = (iau || '').trim().toLowerCase();
  if (!code) {
    return [];
  }
  return ASTRO_BRIGHT_STARS.filter((s) => (s.constellation || '').toLowerCase() === code);
}

/** Bright catalog star closest to the constellation geometric centre (J2000). */
export function constellationCenterStar(item: AstroConstellationOption): AstroStarOption | undefined {
  const members = constellationMemberStars(item.iau);
  if (!members.length) {
    return undefined;
  }
  let best: AstroStarOption | undefined;
  let bestSep = Infinity;
  for (const star of members) {
    const sep = angularSepDeg(item.raHours, item.decDeg, star.raHours, star.decDeg);
    if (sep < bestSep) {
      bestSep = sep;
      best = star;
    }
  }
  return best;
}

function angularSepDeg(raHours1: number, decDeg1: number, raHours2: number, decDeg2: number): number {
  const ra1 = (raHours1 * 15 * Math.PI) / 180;
  const ra2 = (raHours2 * 15 * Math.PI) / 180;
  const d1 = (decDeg1 * Math.PI) / 180;
  const d2 = (decDeg2 * Math.PI) / 180;
  const cos = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(ra1 - ra2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

export function constellationStickLines(id: string): ReadonlyArray<readonly [string, string]> {
  return CONSTELLATION_STICK_LINES[id] || [];
}

function matchesConstellationQuery(obj: AstroConstellationOption, q: string): boolean {
  if (obj.name.toLowerCase().includes(q) || obj.nameFr.toLowerCase().includes(q) || obj.id.includes(q)) {
    return true;
  }
  if (obj.iau.toLowerCase().includes(q)) {
    return true;
  }
  return obj.aliases.some((a) => a.toLowerCase().includes(q));
}

export function findConstellationsByQuery(
  query: string,
  lang = 'fr'
): AstroConstellationOption[] {
  const q = query.trim().toLowerCase();
  const list = !q
    ? [...ASTRO_CONSTELLATIONS]
    : ASTRO_CONSTELLATIONS.filter((item) => matchesConstellationQuery(item, q));
  const locale = (lang || 'fr').toLowerCase();
  const useFr = locale.startsWith('fr');
  return list.sort((a, b) => {
    const na = useFr ? a.nameFr : a.name;
    const nb = useFr ? b.nameFr : b.name;
    return na.localeCompare(nb, locale, { sensitivity: 'base' });
  });
}
