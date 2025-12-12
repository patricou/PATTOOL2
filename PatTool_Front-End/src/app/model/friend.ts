import { Member } from './member';

export enum FriendRequestStatus {
    PENDING = 'PENDING',
    ACCEPTED = 'ACCEPTED',
    REJECTED = 'REJECTED'
}

export class FriendRequest {
    constructor(
        public id: string,
        public requester: Member,
        public recipient: Member,
        public status: FriendRequestStatus,
        public requestDate: Date,
        public responseDate?: Date,
        public message?: string // Optional custom message from requester
    ) {}
}

export class Friend {
    constructor(
        public id: string,
        public user1: Member,
        public user2: Member,
        public friendshipDate: Date
    ) {}
}

export class FriendGroup {
    constructor(
        public id: string,
        public name: string,
        public members: Member[],
        public owner: Member,
        public creationDate: Date,
        public authorizedUsers?: Member[], // Users authorized to use this group (but not to add members)
        public discussionId?: string, // ID of the discussion associated with this friend group
        public whatsappLink?: string // WhatsApp group link or invite link for this friend group
    ) {}
}

