import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { Member } from '../model/member';
import { IotService } from '../services/iot.service';
import { MembersService } from '../services/members.service';

@Component({
  selector: 'app-iothome',
  templateUrl: './iothome.component.html',
  styleUrls: ['./iothome.component.css'],
  standalone: true,
  imports: [CommonModule, TranslateModule, NavigationButtonsModule]
})
export class IothomeComponent implements OnInit {

  public user: Member = this._memberService.getUser();
  iotResponse: string = '';
  iotTestResponse: string = '';
  messageVisible: boolean = false;
  messageTestVisible: boolean = false;

  constructor(private _memberService: MembersService, private _iotService: IotService) { }

  ngOnInit() {
  }

  openOrCLosePortail(): void {
    this._iotService.openOrClosePortail(this.user).subscribe(
      response => {
        console.log("Response from Portail : " + JSON.stringify(response));
        // Extract the message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        this.iotResponse = responseData.Arduino || responseData.message || JSON.stringify(responseData);
        this.messageVisible = true;

        // Masquer le message après 25 secondes (25 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
        }, 25000);
      },
      error => {
        // En cas d'erreur
        this.iotResponse = error.message;
        this.messageVisible = true;

        // Masquer le message après 21 secondes (21 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
        }, 21000);
      });
  }

  testEthernetShield(): void {
    this._iotService.testEThernetShield(this.user).subscribe(
      response => {
        console.log("Response from Arduino : " + JSON.stringify(response));
        // Extract the Arduino message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        this.iotTestResponse = responseData.Arduino || JSON.stringify(responseData);
        this.messageTestVisible = true;

        // Masquer le message après 3 secondes (3 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
        }, 3000);
      },
      error => {
        // En cas d'erreur
        this.iotTestResponse = error.message;
        this.messageTestVisible = true;

        // Masquer le message après 5 secondes (5 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
        }, 5000);
      });
  }
}
