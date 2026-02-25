import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';

@Component({
  selector: 'app-acces-refuse-evenement',
  templateUrl: './acces-refuse-evenement.component.html',
  styleUrls: ['./acces-refuse-evenement.component.css'],
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule, NgbModule]
})
export class AccesRefuseEvenementComponent {

  eventId: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public translate: TranslateService
  ) {
    this.eventId = this.route.snapshot.paramMap.get('id');
  }

  goToActivities(): void {
    this.router.navigate(['/even']);
  }
}
