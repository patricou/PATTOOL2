export class Camera {
    constructor(
        public id: string = '',
        public uid: string = '',
        public name: string = '',
        public owner: string = '',
        public creationDate?: Date,
        public updateDate?: Date,
        public brand: string = '',
        public type: string = '',
        public webUrl: string = '',
        public snapshotUrl: string = '',
        public username: string = '',
        public password: string = '',
        public hasPassword: boolean = false,
        public service: string = '',
        public macaddress: string = '',
        public ip: string = '',
        public place: string = '',
        public room: string = '',
        public param1: string = '',
        public param2: string = '',
        public param3: string = ''
    ) {}
}
