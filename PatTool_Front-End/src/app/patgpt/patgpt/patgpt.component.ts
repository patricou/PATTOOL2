import { Component, OnInit } from '@angular/core';
import { ChatResponse } from '../../model/chat-response';
import { PatgptService } from '../../services/patgpt.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-patgpt',
  templateUrl: './patgpt.component.html',
  styleUrls: ['./patgpt.component.css']
})
export class PatgptComponent implements OnInit {

  userInput: string = '';
  chatResponse: ChatResponse | null = null;
  currentDate: Date = new Date();
  private intervalId: any;
  private URL4PATGPT: string = environment.URL4PATGPT;
  sendWithHistorical: boolean = true;
  lastxquestion: boolean = true;
  public isLoading: boolean = false;

  constructor(private patgptService: PatgptService) { }

  ngOnInit() {
    this.intervalId = setInterval(() => {
      this.currentDate = new Date();
    }, 1000);
  }

  sendQuestion() {
    this.isLoading = true;
    this.chatResponse = null;
    this.patgptService.getPatGptResponse(this.userInput, this.sendWithHistorical, this.lastxquestion).subscribe(response => {
      this.isLoading = false;
      this.chatResponse = response;
    });
  }

  onUserInput(event: Event) {
    this.userInput = (event.target as HTMLTextAreaElement).value;
  }

  clearTextArea(): void {
    this.userInput = '';
  }

  navigateToHistorical(): void {
    window.open(this.URL4PATGPT + "h2-console", '_blank');
  }

  clearHistorical(): void {
    this.chatResponse = null;
    this.userInput = '';
    const response = confirm("New discussion ? ( You are going to delete the historical ).");
    if (response) {
      this.patgptService.delPatGptHistorical().subscribe(response => {

      });
    }
  }

}