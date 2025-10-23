import { Member } from './member';

export class Commentary {
    constructor(
        public owner: Member,
        public commentary: string,
        public dateCreation: Date
    ) { }
}
