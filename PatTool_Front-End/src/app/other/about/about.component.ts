import { Component, HostListener, OnInit } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
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
  isLoadingPreview: boolean = false;
  previewError: string = '';
  reportHtml: SafeHtml | null = null;
  isPreviewVisible: boolean = false;

  constructor(
    private exceptionReportService: ExceptionReportService,
    private sanitizer: DomSanitizer
  ) {
  }

  ngOnInit() {

  }

  sendExceptionReport() {
    this.isSendingReport = true;
    this.reportMessage = '';
    this.reportError = '';
    this.previewError = '';

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

  viewExceptionReport() {
    this.isLoadingPreview = true;
    this.previewError = '';
    this.reportHtml = null;
    this.isPreviewVisible = false;

    this.exceptionReportService.getExceptionReportPreview().subscribe({
      next: (html) => {
        this.isLoadingPreview = false;
        this.reportHtml = this.sanitizer.bypassSecurityTrustHtml(html);
        this.isPreviewVisible = true;
      },
      error: (error) => {
        this.isLoadingPreview = false;
        this.previewError = error.error || error.message || 'Error retrieving exception report';
        console.error('Error retrieving exception report preview:', error);
        this.isPreviewVisible = false;
      }
    });
  }

  closePreview(): void {
    this.isPreviewVisible = false;
  }

}
