import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
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
  isLoadingPortail: boolean = false;
  isLoadingTest: boolean = false;

  constructor(
    private _memberService: MembersService, 
    private _iotService: IotService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
  }

  openOrCLosePortail(): void {
    // Empêcher les clics multiples
    if (this.isLoadingPortail) {
      return;
    }
    
    // Désactiver immédiatement le bouton et afficher l'état de chargement
    this.isLoadingPortail = true;
    this.messageVisible = false;
    this.iotResponse = '';
    this.cdr.detectChanges(); // Force update pour afficher le spinner immédiatement
    
    this._iotService.openOrClosePortail(this.user).subscribe({
      next: (response) => {
        console.log("Response from Portail : " + JSON.stringify(response));
        
        // Extract the message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotResponse = responseData.Arduino || responseData.message || JSON.stringify(responseData);
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingPortail = false;
        this.messageVisible = true;
        
        // Force immediate UI update pour afficher le résultat dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 25 secondes (25 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
          this.cdr.detectChanges();
        }, 25000);
      },
      error: (error) => {
        console.error("Error from Portail:", error);
        
        // En cas d'erreur, extraire le message d'erreur
        let errorMessage = 'Erreur lors de la communication avec le portail';
        if (error.error) {
          if (typeof error.error === 'string') {
            errorMessage = error.error;
          } else if (error.error.message) {
            errorMessage = error.error.message;
          } else if (error.error.Arduino) {
            errorMessage = error.error.Arduino;
          }
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotResponse = errorMessage;
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingPortail = false;
        this.messageVisible = true;
        
        // Force immediate UI update pour afficher l'erreur dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 21 secondes (21 000 ms)
        setTimeout(() => {
          this.messageVisible = false;
          this.iotResponse = '';
          this.cdr.detectChanges();
        }, 21000);
      }
    });
  }

  testEthernetShield(): void {
    // Empêcher les clics multiples
    if (this.isLoadingTest) {
      return;
    }
    
    // Désactiver immédiatement le bouton et afficher l'état de chargement
    this.isLoadingTest = true;
    this.messageTestVisible = false;
    this.iotTestResponse = '';
    this.cdr.detectChanges(); // Force update pour afficher le spinner immédiatement
    
    this._iotService.testEThernetShield(this.user).subscribe({
      next: (response) => {
        console.log("Response from Arduino : " + JSON.stringify(response));
        
        // Extract the Arduino message from the JSON response
        let responseData = response;
        if (response._body) {
          responseData = typeof response._body === 'string' ? JSON.parse(response._body) : response._body;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotTestResponse = responseData.Arduino || JSON.stringify(responseData);
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingTest = false;
        this.messageTestVisible = true;
        
        // Force immediate UI update pour afficher le résultat dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 3 secondes (3 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
          this.cdr.detectChanges();
        }, 3000);
      },
      error: (error) => {
        console.error("Error from Arduino:", error);
        
        // En cas d'erreur, extraire le message d'erreur
        let errorMessage = 'Erreur lors du test de l\'Ethernet Shield';
        if (error.error) {
          if (typeof error.error === 'string') {
            errorMessage = error.error;
          } else if (error.error.message) {
            errorMessage = error.error.message;
          } else if (error.error.Arduino) {
            errorMessage = error.error.Arduino;
          }
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        // Mettre à jour les données AVANT de changer les flags
        this.iotTestResponse = errorMessage;
        
        // Mettre à jour les flags et forcer l'affichage immédiat
        this.isLoadingTest = false;
        this.messageTestVisible = true;
        
        // Force immediate UI update pour afficher l'erreur dès la réception
        requestAnimationFrame(() => {
          this.cdr.detectChanges();
        });

        // Masquer le message après 5 secondes (5 000 ms)
        setTimeout(() => {
          this.messageTestVisible = false;
          this.iotTestResponse = '';
          this.cdr.detectChanges();
        }, 5000);
      }
    });
  }
}
