import { Member } from "./member";

export class Category {
    constructor(            
        public id:string,        
        public categoryLinkID:string,
        public categoryName:string,      
        public categoryDescription:string,
        public author:Member,
        public visibility:string
        ){}
}