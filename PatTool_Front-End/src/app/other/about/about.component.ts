import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-home-maps',
  standalone: true,
  imports: [CommonModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.css']
})
export class AboutComponent implements OnInit {
  showFirebaseInAbout = false;

  constructor() {
  }

  ngOnInit() {
    // Default to hiding Firebase details unless explicitly enabled in the environment.
    // This avoids exposing provider details on the About page by default.
    this.showFirebaseInAbout = (environment as any).showFirebaseInAbout === true;
  }

}
