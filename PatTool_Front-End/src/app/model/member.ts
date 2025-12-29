 export class Member{

    constructor(  
        public id: string,
        public addressEmail: string,
        public firstName: string,
        public lastName: string,
        public userName: string,
        public roles : string[],
        public keycloakId : string,
        public registrationDate?: Date,
        public lastConnectionDate?: Date,
        public locale?: string,
        public whatsappLink?: string,
        public visible?: boolean
    )
    {}
}