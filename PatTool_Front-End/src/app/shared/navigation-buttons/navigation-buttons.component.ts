import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';

@Component({
  selector: 'app-navigation-buttons',
  templateUrl: './navigation-buttons.component.html',
  styleUrls: ['./navigation-buttons.component.css']
})
export class NavigationButtonsComponent implements OnInit {
  
  canGoBack: boolean = false;
  canGoForward: boolean = false;

  constructor(private location: Location) {}

  ngOnInit() {
    this.updateNavigationState();
  }

  goBack() {
    if (this.canGoBack) {
      this.location.back();
      // Mettre à jour l'état après un court délai
      setTimeout(() => this.updateNavigationState(), 100);
    }
  }

  goForward() {
    if (this.canGoForward) {
      this.location.forward();
      // Mettre à jour l'état après un court délai
      setTimeout(() => this.updateNavigationState(), 100);
    }
  }

  refreshPage() {
    // Rafraîchir la page actuelle
    window.location.reload();
  }

  private updateNavigationState() {
    // Vérifier si on peut naviguer en arrière
    this.canGoBack = window.history.length > 1;
    
    // Pour le forward, on utilise une approche simple
    // Le bouton sera actif si on a un historique
    this.canGoForward = window.history.length > 1;
  }
}
