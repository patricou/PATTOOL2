import { Member } from './member';
import { UploadedFile } from '../model/uploadedfile';
import { UrlEvent } from './url-event';
import { Commentary } from './commentary';

export class Evenement {

    constructor(
        public author: Member,
        public closeInscriptionDate: Date,
        public comments: string,
        public creationDate: Date,
        public endEventDate: Date,
        public beginEventDate: Date,
        public evenementName: string,
        public id: string,
        public members: Member[],
        public openInscriptionDate: Date,
        public status: string,
        public type: string,
        public fileUploadeds: UploadedFile[],
        public startHour: string,
        public diffculty: string,
        public startLocation: string,
        public durationEstimation: string,
        public ratingPlus: number,
        public ratingMinus: number,
        public visibility: string,
        public urlEvents: UrlEvent[],
        public commentaries: Commentary[],
        public thumbnail?: UploadedFile, // Thumbnail file (file with "thumbnail" in its name)
        public friendGroupId?: string, // ID of the friend group for visibility (when visibility is a friend group) - DEPRECATED: use friendGroupIds instead
        public friendGroupIds?: string[], // IDs of the friend groups for visibility (when visibility is friend groups)
        public discussionId?: string, // ID of the discussion associated with this event
        public notes?: string // Notes field for additional event information
    ) { }
}