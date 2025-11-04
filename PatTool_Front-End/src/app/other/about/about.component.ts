import { Component, OnInit } from '@angular/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ExceptionReportService } from '../../services/exception-report.service';

@Component({
  selector: 'app-home-maps',
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.css']
})
export class AboutComponent implements OnInit {

  isSendingReport: boolean = false;
  reportMessage: string = '';
  reportError: string = '';

  constructor(private exceptionReportService: ExceptionReportService) {
  }

  ngOnInit() {

  }

  sendExceptionReport() {
    this.isSendingReport = true;
    this.reportMessage = '';
    this.reportError = '';

    this.exceptionReportService.sendExceptionReport().subscribe({
      next: (response) => {
        this.isSendingReport = false;
        this.reportMessage = response || 'Exception report sent successfully';
        this.reportError = '';
      },
      error: (error) => {
        this.isSendingReport = false;
        this.reportError = error.error || error.message || 'Error sending exception report';
        this.reportMessage = '';
        console.error('Error sending exception report:', error);
      }
    });
  }

}
