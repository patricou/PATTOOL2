export class UrlEvent {
    constructor(
        public typeUrl: string,
        public dateCreation: Date,
        public owner: string,
        public link: string,
        public urlDescription: string
    ) { }
}
