/** NAF 2008 → short French label (SIRENE often omits libelle_activite_principale). */
export const NAF_ACTIVITY_LABELS: Record<string, string> = {
  '41.20A': 'Construction de maisons individuelles',
  '41.20B': "Construction d'autres bâtiments",
  '43.11Z': 'Démolition',
  '43.12A': 'Terrassement',
  '43.12B': 'Terrassement spécialisé',
  '43.13Z': 'Forages et sondages',
  '43.21A': 'Installation électrique',
  '43.21B': 'Installation électrique voirie',
  '43.22A': 'Plomberie / eau et gaz',
  '43.22B': 'Chauffage et climatisation',
  '43.29A': 'Isolation',
  '43.29B': 'Autres installations (bâtiment)',
  '43.31Z': 'Plâtrerie',
  '43.32A': 'Menuiserie bois et PVC',
  '43.32B': 'Menuiserie métallique et serrurerie',
  '43.32C': 'Agencement de lieux de vente',
  '43.33Z': 'Revêtement des sols et murs',
  '43.34Z': 'Peinture et vitrerie',
  '43.39Z': 'Autres travaux de finition',
  '43.91A': 'Charpente',
  '43.91B': 'Couverture',
  '43.99A': 'Étanchéité',
  '43.99B': 'Montage de structures métalliques',
  '43.99C': 'Maçonnerie et gros œuvre',
  '43.99D': 'Travaux spécialisés de construction',
  '43.99E': 'Location de matériel de chantier',
  '16.23Z': 'Fabrication de charpentes et menuiseries',
  '25.12Z': 'Portes et fenêtres en métal',
  '31.09B': "Fabrication d'autres meubles",
  '45.20A': 'Réparation de véhicules légers',
  '45.20B': "Réparation d'autres véhicules",
  '81.21Z': 'Nettoyage de bâtiments',
  '81.22Z': 'Nettoyage industriel / bâtiments',
  '81.30Z': 'Aménagement paysager',
  '95.21Z': "Réparation d'électroménager",
  '95.22Z': 'Réparation de chaussures et cuir',
  '95.29Z': 'Réparation d’autres biens personnels',
  '96.02A': 'Coiffure',
  '96.02B': 'Soins de beauté',
  '96.01A': 'Blanchisserie-teinturerie de détail',
  '96.01B': 'Blanchisserie-teinturerie de gros',
  '86.21Z': 'Activité des médecins généralistes',
  '86.22A': 'Activités de radiodiagnostic et de radiothérapie',
  '86.23Z': 'Pratique dentaire',
  '75.00Z': 'Activités vétérinaires',
  '68.31Z': 'Agences immobilières',
  '64.19Z': 'Autres intermédiations monétaires',
  '65.11Z': 'Assurance vie',
  '65.12Z': 'Autres assurances',
  '66.21Z': 'Évaluation des risques et dommages',
  '66.22Z': 'Courtage d’assurances',
  '46.21Z': 'Commerce de gros de céréales',
  '46.73B': 'Commerce de gros de bois et matériaux',
  '47.41Z': 'Commerce d’ordinateurs, d’unités périphériques et de logiciels',
  '47.42Z': 'Commerce de matériels de télécommunication',
  '47.43Z': 'Commerce d’équipements audio/vidéo',
  '47.61Z': 'Commerce de livres',
  '47.62Z': 'Commerce de journaux et papeterie',
  '47.64Z': 'Commerce d’articles de sport',
  '47.72Z': 'Commerce de chaussures',
  '47.77Z': 'Commerce d’articles d’horlogerie et de bijouterie',
  '10.71C': 'Boulangerie-pâtisserie',
  '10.71D': 'Pâtisserie',
  '23.12Z': 'Façonnage et transformation du verre',
  '47.11A': 'Hypermarchés',
  '47.11B': 'Supermarchés',
  '47.11C': 'Magasins multi-commerces',
  '47.11D': 'Mini-marchés',
  '47.11E': "Commerce d'alimentation générale",
  '47.19A': 'Grands magasins',
  '47.19B': 'Autres commerces non spécialisés',
  '47.21Z': 'Commerce de fruits et légumes',
  '47.22Z': 'Commerce de viandes',
  '47.24Z': 'Commerce de pain et pâtisserie',
  '47.29Z': 'Autres commerces alimentaires',
  '47.30Z': 'Commerce de carburants',
  '47.52A': 'Quincaillerie',
  '47.52B': 'Peintures et verres (bricolage)',
  '47.54Z': "Commerce d'électroménager",
  '47.59A': 'Commerce de meubles',
  '47.71Z': "Commerce d'habillement",
  '47.73Z': 'Pharmacie',
  '47.76Z': 'Commerce de fleurs',
  '47.78A': "Commerces d'optique",
  '55.10Z': 'Hôtels et hébergement similaire',
  '56.10A': 'Restauration traditionnelle',
  '56.10B': 'Cafétérias et autres libres-services',
  '56.10C': 'Restauration rapide',
  '56.30Z': 'Débits de boissons'
};

export const NAF_TRADE_KEYS: Record<string, string> = {
  '41.20A': 'mason',
  '41.20B': 'mason',
  '43.11Z': 'mason',
  '43.12A': 'mason',
  '43.12B': 'mason',
  '43.13Z': 'mason',
  '43.21A': 'electrician',
  '43.21B': 'electrician',
  '43.22A': 'plumber',
  '43.22B': 'heating',
  '43.29A': 'isolation',
  '43.29B': 'electrician',
  '43.31Z': 'plasterer',
  '43.32A': 'carpenter',
  '43.32B': 'locksmith',
  '43.32C': 'carpenter',
  '43.34Z': 'painter',
  '43.39Z': 'painter',
  '43.91A': 'roofer',
  '43.91B': 'roofer',
  '43.99A': 'roofer',
  '43.99B': 'locksmith',
  '43.99C': 'mason',
  '43.99D': 'mason',
  '43.99E': 'mason',
  '16.23Z': 'carpenter',
  '25.12Z': 'locksmith',
  '45.20A': 'mechanic',
  '45.20B': 'mechanic',
  '81.21Z': 'cleaner',
  '81.22Z': 'cleaner',
  '81.30Z': 'gardener',
  '95.21Z': 'appliance',
  '96.02A': 'hairdresser',
  '96.02B': 'beauty',
  '10.71C': 'baker',
  '10.71D': 'baker',
  '23.12Z': 'glazier',
  '43.33Z': 'tiler',
  '47.11A': 'supermarket',
  '47.11B': 'supermarket',
  '47.11C': 'supermarket',
  '47.11D': 'grocery',
  '47.11E': 'grocery',
  '47.19A': 'shop',
  '47.19B': 'shop',
  '47.21Z': 'grocery',
  '47.22Z': 'butcher',
  '47.24Z': 'baker',
  '47.29Z': 'grocery',
  '47.30Z': 'fuel',
  '47.52A': 'hardware',
  '47.52B': 'hardware',
  '47.54Z': 'appliance',
  '47.59A': 'furniture',
  '47.71Z': 'clothing',
  '47.72Z': 'shoes',
  '47.73Z': 'pharmacy',
  '47.76Z': 'florist',
  '47.77Z': 'jewelry',
  '47.78A': 'optician',
  '47.41Z': 'electronics',
  '47.42Z': 'electronics',
  '47.43Z': 'electronics',
  '47.61Z': 'books',
  '47.62Z': 'books',
  '47.64Z': 'sports',
  '55.10Z': 'hotel',
  '56.10A': 'restaurant',
  '56.10B': 'restaurant',
  '56.10C': 'restaurant',
  '56.30Z': 'cafe',
  '64.19Z': 'bank',
  '65.11Z': 'insurance',
  '65.12Z': 'insurance',
  '66.21Z': 'insurance',
  '66.22Z': 'insurance',
  '46.21Z': 'wholesale',
  '46.73B': 'wholesale',
  '68.31Z': 'realestate',
  '75.00Z': 'veterinary',
  '86.21Z': 'doctor',
  '86.22A': 'doctor',
  '86.23Z': 'dentist',
  '96.01A': 'laundry',
  '96.01B': 'laundry'
};

export const BASE_TRADES = [
  'plumber',
  'electrician',
  'heating',
  'painter',
  'carpenter',
  'mason',
  'roofer',
  'locksmith',
  'tiler',
  'glazier',
  'gardener',
  'cleaner',
  'hairdresser',
  'baker',
  'butcher',
  'mechanic',
  'appliance',
  'supermarket',
  'grocery',
  'shop',
  'hardware',
  'clothing',
  'furniture',
  'florist',
  'pharmacy',
  'optician',
  'restaurant',
  'cafe',
  'hotel',
  'fuel'
] as const;

export const SIRENE_EXTRA_TRADES = [
  'isolation',
  'plasterer',
  'beauty',
  'dentist',
  'doctor',
  'veterinary',
  'realestate',
  'laundry',
  'bank',
  'insurance',
  'wholesale',
  'shoes',
  'electronics',
  'books',
  'sports',
  'jewelry'
] as const;

export const OSM_EXTRA_TRADES = [
  'beauty',
  'dentist',
  'doctor',
  'veterinary',
  'realestate',
  'laundry',
  'bank',
  'insurance',
  'wholesale',
  'post',
  'shoes',
  'electronics',
  'books',
  'sports',
  'jewelry',
  'bar',
  'fastfood'
] as const;

export const SIRENE_TRADES = ['all', ...BASE_TRADES, ...SIRENE_EXTRA_TRADES] as const;
export const OSM_TRADES = ['all', ...BASE_TRADES, ...OSM_EXTRA_TRADES] as const;

export const TRADE_NAF_CODES: Record<string, string[]> = {
  plumber: ['43.22A'],
  electrician: ['43.21A', '43.21B'],
  heating: ['43.22B'],
  painter: ['43.34Z'],
  carpenter: ['43.32A', '43.32B', '16.23Z'],
  mason: ['43.99C', '43.99D', '43.11Z', '43.12A', '43.12B', '43.13Z', '41.20A', '41.20B'],
  roofer: ['43.91A', '43.91B', '43.99A'],
  locksmith: ['43.32B'],
  gardener: ['81.30Z'],
  hairdresser: ['96.02A'],
  baker: ['10.71C', '10.71D', '47.24Z'],
  mechanic: ['45.20A', '45.20B'],
  appliance: ['95.21Z', '47.54Z'],
  tiler: ['43.33Z'],
  glazier: ['23.12Z'],
  cleaner: ['81.21Z', '81.22Z'],
  butcher: ['47.22Z'],
  supermarket: ['47.11A', '47.11B', '47.11C'],
  grocery: ['47.11D', '47.11E', '47.21Z', '47.29Z'],
  shop: ['47.19A', '47.19B'],
  hardware: ['47.52A', '47.52B'],
  clothing: ['47.71Z'],
  furniture: ['47.59A'],
  florist: ['47.76Z'],
  pharmacy: ['47.73Z'],
  optician: ['47.78A'],
  restaurant: ['56.10A', '56.10B', '56.10C'],
  cafe: ['56.30Z'],
  hotel: ['55.10Z'],
  fuel: ['47.30Z'],
  isolation: ['43.29A'],
  plasterer: ['43.31Z'],
  beauty: ['96.02B'],
  dentist: ['86.23Z'],
  doctor: ['86.21Z', '86.22A'],
  veterinary: ['75.00Z'],
  realestate: ['68.31Z'],
  laundry: ['96.01A', '96.01B'],
  bank: ['64.19Z'],
  shoes: ['47.72Z'],
  electronics: ['47.41Z', '47.42Z', '47.43Z'],
  books: ['47.61Z', '47.62Z'],
  sports: ['47.64Z'],
  jewelry: ['47.77Z'],
  insurance: ['65.11Z', '65.12Z', '66.21Z', '66.22Z'],
  wholesale: [
    '46.21Z', '46.31Z', '46.32Z', '46.33Z', '46.34Z', '46.36Z', '46.37Z', '46.38A', '46.38B', '46.39Z',
    '46.41Z', '46.42Z', '46.43Z', '46.44Z', '46.45Z', '46.46Z', '46.47Z', '46.49Z',
    '46.51Z', '46.52Z', '46.61Z', '46.62Z', '46.63Z', '46.69A', '46.69B', '46.69C',
    '46.71Z', '46.72Z', '46.73A', '46.73B', '46.74A', '46.74B', '46.75Z', '46.76Z', '46.77Z', '46.90Z'
  ]
};

export const OSM_ACTIVITY_LABELS: Record<string, string> = {
  plumber: 'Plomberie',
  heating_engineer: 'Chauffage',
  hvac: 'Chauffage / climatisation',
  electrician: 'Électricité',
  painter: 'Peinture',
  carpenter: 'Menuiserie',
  joiner: 'Menuiserie',
  mason: 'Maçonnerie',
  roofer: 'Couverture',
  locksmith: 'Serrurerie',
  gardener: 'Paysagiste',
  hairdresser: 'Coiffure',
  beauty: 'Soins de beauté',
  bakery: 'Boulangerie',
  car_repair: 'Garage automobile',
  appliance: 'Électroménager',
  electronics_repair: 'Réparation électronique',
  window_construction: 'Menuiserie / fenêtres',
  tiler: 'Carrelage',
  glazier: 'Vitrerie',
  cleaner: 'Nettoyage',
  butcher: 'Boucherie',
  greengrocer: 'Fruits et légumes',
  supermarket: 'Supermarché',
  hypermarket: 'Hypermarché',
  convenience: 'Épicerie',
  grocery: 'Alimentation',
  general: 'Magasin',
  department_store: 'Grand magasin',
  mall: 'Centre commercial',
  clothes: 'Habillement',
  shoes: 'Chaussures',
  electronics: 'Électronique',
  computer: 'Informatique',
  books: 'Librairie',
  sports: 'Sport',
  jewelry: 'Bijouterie',
  furniture: 'Meubles',
  doityourself: 'Bricolage',
  hardware: 'Quincaillerie',
  florist: 'Fleuriste',
  chemist: 'Pharmacie',
  pharmacy: 'Pharmacie',
  optician: 'Opticien',
  restaurant: 'Restaurant',
  fast_food: 'Restauration rapide',
  cafe: 'Café',
  bar: 'Bar',
  pub: 'Bar',
  hotel: 'Hôtel',
  fuel: 'Station-service',
  dentist: 'Dentiste',
  doctors: 'Médecin',
  clinic: 'Clinique',
  veterinary: 'Vétérinaire',
  bank: 'Banque',
  insurance: 'Assurance',
  wholesale: 'Commerce de gros',
  post_office: 'La Poste',
  estate_agent: 'Agence immobilière',
  laundry: 'Pressing / laverie',
  dry_cleaning: 'Pressing'
};

export const OSM_TRADE_KEYS: Record<string, string> = {
  plumber: 'plumber',
  heating_engineer: 'heating',
  hvac: 'heating',
  electrician: 'electrician',
  painter: 'painter',
  carpenter: 'carpenter',
  joiner: 'carpenter',
  mason: 'mason',
  roofer: 'roofer',
  locksmith: 'locksmith',
  gardener: 'gardener',
  hairdresser: 'hairdresser',
  beauty: 'beauty',
  bakery: 'baker',
  car_repair: 'mechanic',
  appliance: 'appliance',
  electronics_repair: 'appliance',
  tiler: 'tiler',
  glazier: 'glazier',
  cleaner: 'cleaner',
  butcher: 'butcher',
  greengrocer: 'grocery',
  supermarket: 'supermarket',
  hypermarket: 'supermarket',
  convenience: 'grocery',
  grocery: 'grocery',
  general: 'shop',
  kiosk: 'shop',
  variety_store: 'shop',
  department_store: 'shop',
  mall: 'shop',
  clothes: 'clothing',
  shoes: 'shoes',
  furniture: 'furniture',
  electronics: 'electronics',
  computer: 'electronics',
  books: 'books',
  newsagent: 'books',
  sports: 'sports',
  jewelry: 'jewelry',
  doityourself: 'hardware',
  hardware: 'hardware',
  florist: 'florist',
  chemist: 'pharmacy',
  pharmacy: 'pharmacy',
  optician: 'optician',
  restaurant: 'restaurant',
  fast_food: 'fastfood',
  cafe: 'cafe',
  bar: 'bar',
  pub: 'bar',
  hotel: 'hotel',
  fuel: 'fuel',
  dentist: 'dentist',
  doctors: 'doctor',
  clinic: 'doctor',
  veterinary: 'veterinary',
  bank: 'bank',
  insurance: 'insurance',
  wholesale: 'wholesale',
  post_office: 'post',
  estate_agent: 'realestate',
  laundry: 'laundry',
  dry_cleaning: 'laundry'
};

export function normalizeNaf(code: string | undefined | null): string {
  return (code || '').trim().toUpperCase();
}

export function tradeKeyFromCode(code: string | undefined | null): string {
  const raw = (code || '').trim();
  if (!raw) {
    return '';
  }
  const osm = OSM_TRADE_KEYS[raw.toLowerCase()];
  if (osm) {
    return osm;
  }
  const naf = normalizeNaf(raw);
  if (NAF_TRADE_KEYS[naf]) {
    return NAF_TRADE_KEYS[naf];
  }
  if (naf.startsWith('43.21')) {
    return 'electrician';
  }
  if (naf.startsWith('43.22A') || naf === '43.22') {
    return 'plumber';
  }
  if (naf.startsWith('43.22')) {
    return 'heating';
  }
  if (naf.startsWith('43.32B') || naf.startsWith('25.12')) {
    return 'locksmith';
  }
  if (naf.startsWith('43.32')) {
    return 'carpenter';
  }
  if (naf.startsWith('43.33')) {
    return 'tiler';
  }
  if (naf.startsWith('43.34') || naf.startsWith('43.39')) {
    return 'painter';
  }
  if (naf.startsWith('43.91') || naf.startsWith('43.99A')) {
    return 'roofer';
  }
  if (naf.startsWith('43.29A')) {
    return 'isolation';
  }
  if (naf.startsWith('43.31')) {
    return 'plasterer';
  }
  if (naf.startsWith('43.99') || naf.startsWith('43.11') || naf.startsWith('43.12')
      || naf.startsWith('41.')) {
    return 'mason';
  }
  if (naf.startsWith('47.11A') || naf.startsWith('47.11B') || naf.startsWith('47.11C')) {
    return 'supermarket';
  }
  if (naf.startsWith('47.11') || naf.startsWith('47.21') || naf.startsWith('47.29')) {
    return 'grocery';
  }
  if (naf.startsWith('47.22')) {
    return 'butcher';
  }
  if (naf.startsWith('47.24')) {
    return 'baker';
  }
  if (naf.startsWith('47.30')) {
    return 'fuel';
  }
  if (naf.startsWith('47.52')) {
    return 'hardware';
  }
  if (naf.startsWith('47.59')) {
    return 'furniture';
  }
  if (naf.startsWith('47.71')) {
    return 'clothing';
  }
  if (naf.startsWith('47.72')) {
    return 'shoes';
  }
  if (naf.startsWith('47.73')) {
    return 'pharmacy';
  }
  if (naf.startsWith('47.76')) {
    return 'florist';
  }
  if (naf.startsWith('47.78A')) {
    return 'optician';
  }
  if (naf.startsWith('47.19') || naf.startsWith('47.')) {
    return 'shop';
  }
  if (naf.startsWith('56.10')) {
    return 'restaurant';
  }
  if (naf.startsWith('56.30') || naf.startsWith('56.2')) {
    return 'cafe';
  }
  if (naf.startsWith('55.1')) {
    return 'hotel';
  }
  if (naf.startsWith('81.21') || naf.startsWith('81.22')) {
    return 'cleaner';
  }
  if (naf.startsWith('23.12')) {
    return 'glazier';
  }
  if (naf.startsWith('65.') || naf.startsWith('66.2')) {
    return 'insurance';
  }
  if (naf.startsWith('46.')) {
    return 'wholesale';
  }
  return '';
}

export function activityLabelFromCode(code: string | undefined | null): string {
  const raw = (code || '').trim();
  if (!raw) {
    return '';
  }
  const osm = OSM_ACTIVITY_LABELS[raw.toLowerCase()];
  if (osm) {
    return osm;
  }
  const naf = normalizeNaf(raw);
  if (NAF_ACTIVITY_LABELS[naf]) {
    return NAF_ACTIVITY_LABELS[naf];
  }
  if (naf.length >= 5) {
    const prefix = naf.substring(0, 5);
    for (const [key, label] of Object.entries(NAF_ACTIVITY_LABELS)) {
      if (key.startsWith(prefix)) {
        return label;
      }
    }
  }
  if (naf.startsWith('43.21')) {
    return 'Installation électrique';
  }
  if (naf.startsWith('43.22')) {
    return 'Plomberie / chauffage';
  }
  if (naf.startsWith('43.3')) {
    return 'Travaux de finition';
  }
  if (naf.startsWith('43.9')) {
    return 'Gros œuvre / couverture';
  }
  if (naf.startsWith('43.')) {
    return 'Travaux de bâtiment';
  }
  if (naf.startsWith('41.')) {
    return 'Construction de bâtiments';
  }
  if (naf.startsWith('42.')) {
    return 'Génie civil';
  }
  return raw.replace(/_/g, ' ');
}
