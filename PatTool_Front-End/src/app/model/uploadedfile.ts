import { Member } from '../model/member';
 export class UploadedFile{

    constructor(  
        public fieldId: string,
        public fileName: string,
        public fileType: string,
        public uploaderMember : Member
    )
    {}
}