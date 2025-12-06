import { Member } from './member';

export class UserConnectionLog {
    constructor(
        public id?: string,
        public member?: Member,
        public connectionDate?: Date,
        public ipAddress?: string,
        public domainName?: string,
        public location?: string
    ) {}
}

