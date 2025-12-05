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
        public responseDate?: Date
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
        public creationDate: Date
    ) {}
}

