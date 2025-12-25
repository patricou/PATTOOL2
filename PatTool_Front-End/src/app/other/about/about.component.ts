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

  constructor() {
  }

  ngOnInit() {
  }

}
