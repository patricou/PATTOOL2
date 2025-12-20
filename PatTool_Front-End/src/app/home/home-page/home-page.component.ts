import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';

@Component({
	selector: 'app-home-page',
	standalone: true,
	imports: [CommonModule, TranslateModule],
	templateUrl: './home-page.component.html',
	styleUrls: ['./home-page.component.css']
})
export class HomePageComponent implements OnInit {

	selectedFiles: File[] = [];

	constructor(private http: HttpClient) { }

	ngOnInit() { }

	
}
