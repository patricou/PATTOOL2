import { Member } from '../model/member';
 export class UploadedFile{

    constructor(
        public fieldId: string,
        public fileName: string,
        public fileType: string,
        public uploaderMember: Member,
        /** Nom affiché pour les traces GPX/KML/… (mur de photos, cartes). */
        public displayName?: string,
        /** Saisie manuelle : distance (km), prioritaire sur le calcul auto dans le mur de photos. */
        public manualDistanceKm?: number | null,
        /** Saisie manuelle : D+ (m). */
        public manualElevationGainM?: number | null,
        /** Saisie manuelle : date d’activité (yyyy-MM-dd). */
        public manualActivityDate?: string | null
    ) {}
}