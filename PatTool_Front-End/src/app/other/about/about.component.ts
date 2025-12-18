import { Component, OnInit } from '@angular/core';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-home-maps',
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
