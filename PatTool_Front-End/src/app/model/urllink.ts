import { Member } from "./member";

export class urllink{
    constructor(        
        public id: String,
        public urlLinkID: Number,
        public linkDescription:String,
        public linkName:String,
        public url:String,
        public categoryLinkID:Number,
        public visibility:string,
        public author:Member
        ){}
}