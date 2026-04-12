/**
 * Icônes Font Awesome 4.7 pour le type d’activité (codes `evenement.type` "1"…"19" ou libellés).
 * Retourne uniquement la classe de glyphe (ex. `fa-compass`) à combiner avec `class="fa"` sur un `<i>`.
 */
export function getEventTypeFaIconSuffix(type: string | number | undefined | null): string {
    const raw = String(type ?? '').trim();
    if (!raw) {
        return 'fa-tag';
    }
    const byId: { [key: string]: string } = {
        '1': 'fa-bicycle',
        '2': 'fa-snowflake-o',
        '3': 'fa-heartbeat',
        '4': 'fa-compass',
        '5': 'fa-bicycle',
        '6': 'fa-glass',
        '7': 'fa-plane',
        '8': 'fa-globe',
        '9': 'fa-tree',
        '10': 'fa-camera',
        '11': 'fa-file-text',
        '12': 'fa-file-text-o',
        '13': 'fa-glass',
        '14': 'fa-star',
        '15': 'fa-map-marker',
        '16': 'fa-briefcase',
        '17': 'fa-home',
        '18': 'fa-film',
        '19': 'fa-music'
    };
    if (byId[raw]) {
        return byId[raw];
    }
    const norm = raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const aliases: { [key: string]: string } = {
        vtt: 'fa-bicycle',
        ski: 'fa-snowflake-o',
        running: 'fa-heartbeat',
        run: 'fa-heartbeat',
        course: 'fa-heartbeat',
        walk: 'fa-compass',
        marche: 'fa-compass',
        randonnee: 'fa-tree',
        rando: 'fa-tree',
        bike: 'fa-bicycle',
        velo: 'fa-bicycle',
        party: 'fa-glass',
        soiree: 'fa-glass',
        vacation: 'fa-plane',
        travel: 'fa-globe',
        voyage: 'fa-globe',
        hiking: 'fa-tree',
        photos: 'fa-camera',
        documents: 'fa-file-text',
        wine: 'fa-glass',
        vin: 'fa-glass',
        other: 'fa-star',
        autre: 'fa-star',
        visit: 'fa-map-marker',
        visite: 'fa-map-marker',
        work: 'fa-briefcase',
        travail: 'fa-briefcase',
        family: 'fa-home',
        famille: 'fa-home',
        fiche: 'fa-file-text-o',
        cinema: 'fa-film',
        musique: 'fa-music'
    };
    return aliases[norm] || 'fa-thumb-tack';
}
