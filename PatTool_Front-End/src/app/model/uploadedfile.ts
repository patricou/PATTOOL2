import { Member } from '../model/member';
 export class UploadedFile{

    constructor(  
        public fieldId: string,
        public fileName: string,
        public fileType: string,
        public uploaderMember : Member,
        /** Nom affiché pour les traces GPX/KML/… (mur de photos, cartes). */
        public displayName?: string
    )
    {}
}