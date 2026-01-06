import { Member } from './member';

export class UserConnectionLog {
    constructor(
        public id?: string,
        public member?: Member,
        public memberUserName?: string,
        public memberId?: string,
        public connectionDate?: Date,
        public ipAddress?: string,
        public domainName?: string,
        public location?: string,
        public type?: string, // "login" or "discussion"
        public discussionId?: string, // ID of the discussion (if type is "discussion")
        public discussionTitle?: string // Title of the discussion (if type is "discussion")
    ) {}
}

