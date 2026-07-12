import {
  Component,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions } from 'chart.js';
import { MeteoChartFullscreenService } from './meteo-chart-fullscreen.service';

@Component({
  selector: 'app-meteo-france-chart-panel',
  standalone: true,
  imports: [CommonModule, TranslateModule, BaseChartDirective],
  templateUrl: './meteo-france-chart-panel.component.html',
  styleUrls: ['./meteo-france-chart-panel.component.css']
})
export class MeteoFranceChartPanelComponent implements OnChanges, OnDestroy {
  @Input() title = '';
  @Input() titleKey = '';
  @Input() titleIcon = '';
  @Input() headingLevel: 'h4' | 'h5' | 'none' = 'h4';
  @Input() firstInGroup = false;
  @Input() chartType: 'line' | 'bar' = 'line';
  @Input() data: ChartConfiguration<'line' | 'bar'>['data'] = { labels: [], datasets: [] };
  @Input() options: ChartOptions<'line' | 'bar'> = {};
  @Input() chartBoxClass = '';
  @Input() showToolbar = true;
  @Input() showHeader = true;
  @Input() visible = true;

  @ViewChild(BaseChartDirective) chartDir?: BaseChartDirective;

  fullscreen = false;

  private readonly closeFullscreen = () => this.setFullscreen(false);

  constructor(private readonly chartFullscreen: MeteoChartFullscreenService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] || changes['options'] || changes['visible']) {
      this.scheduleChartRefresh();
    }
  }

  ngOnDestroy(): void {
    this.chartFullscreen.unregister(this.closeFullscreen);
  }

  toggleFullscreen(): void {
    this.setFullscreen(!this.fullscreen);
  }

  setFullscreen(fullscreen: boolean): void {
    if (this.fullscreen === fullscreen) {
      return;
    }
    this.fullscreen = fullscreen;
    if (fullscreen) {
      this.chartFullscreen.register(this.closeFullscreen);
    } else {
      this.chartFullscreen.unregister(this.closeFullscreen);
    }
    this.scheduleChartRefresh(fullscreen ? 180 : 120);
  }

  resetZoom(): void {
    const chart = this.chartDir?.chart as (Chart & { resetZoom?: () => void }) | undefined;
    chart?.resetZoom?.();
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (!this.fullscreen) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.setFullscreen(false);
  }

  private scheduleChartRefresh(delayMs = 0): void {
    setTimeout(() => {
      this.chartDir?.chart?.resize();
      this.chartDir?.update();
    }, delayMs);
  }
}
