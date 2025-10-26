import { Member } from "./member";

export class urllink{
    constructor(        
        public id: string,
        public urlLinkID: string,
        public linkDescription:string,
        public linkName:string,
        public url:string,
        public categoryLinkID:string,
        public visibility:string,
        public author:Member
        ){}
}