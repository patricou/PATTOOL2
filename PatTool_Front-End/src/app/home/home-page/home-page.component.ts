import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import {
	PAT_HOME_VIDEO_DESKTOP,
	PAT_HOME_VIDEO_MOBILE,
} from '../../../prefetch-static-assets';

/** Aligné sur Bootstrap 5 `md` (768px) : même logique que d-md-block / d-md-none dans le template. */
const VIEWPORT_MD_MIN_PX = '(min-width: 768px)';

@Component({
	selector: 'app-home-page',
	standalone: true,
	imports: [CommonModule, TranslateModule],
	templateUrl: './home-page.component.html',
	styleUrls: ['./home-page.component.css']
})
export class HomePageComponent implements OnInit, AfterViewInit, OnDestroy {

	selectedFiles: File[] = [];

	@ViewChild('videoDesktop') private videoDesktop?: ElementRef<HTMLVideoElement>;
	@ViewChild('videoMobile') private videoMobile?: ElementRef<HTMLVideoElement>;

	private viewportMql?: MediaQueryList;
	private readonly onViewportChange = () => this.syncBackgroundVideoToViewport();

	constructor() { }

	ngOnInit() { }

	ngAfterViewInit(): void {
		const run = () => {
			this.syncBackgroundVideoToViewport();
			if (typeof window === 'undefined' || !window.matchMedia) {
				return;
			}
			this.viewportMql = window.matchMedia(VIEWPORT_MD_MIN_PX);
			this.viewportMql.addEventListener('change', this.onViewportChange);
		};
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(run, { timeout: 2000 });
		} else {
			setTimeout(run, 0);
		}
	}

	ngOnDestroy(): void {
		this.viewportMql?.removeEventListener('change', this.onViewportChange);
		this.teardownVideos();
	}

	/** Une seule vidéo chargée selon la largeur : évite de retélécharger les deux à chaque visite / refresh. */
	private syncBackgroundVideoToViewport(): void {
		if (typeof window === 'undefined' || !window.matchMedia) {
			this.attachSource(this.videoDesktop?.nativeElement, PAT_HOME_VIDEO_DESKTOP);
			return;
		}
		const mdUp = window.matchMedia(VIEWPORT_MD_MIN_PX).matches;
		if (mdUp) {
			this.attachSource(this.videoDesktop?.nativeElement, PAT_HOME_VIDEO_DESKTOP);
		} else {
			this.attachSource(this.videoMobile?.nativeElement, PAT_HOME_VIDEO_MOBILE);
		}
	}

	private attachSource(video: HTMLVideoElement | undefined, src: string): void {
		if (!video || video.querySelector('source')) {
			return;
		}
		const source = document.createElement('source');
		source.src = src;
		source.type = 'video/mp4';
		video.appendChild(source);
		video.load();
		video.play().catch(() => { /* autoplay policies: stay paused until user gesture */ });
	}

	private teardownVideos(): void {
		const clear = (video: HTMLVideoElement | undefined) => {
			if (!video) {
				return;
			}
			video.pause();
			video.removeAttribute('src');
			video.querySelectorAll('source').forEach((s) => s.remove());
			video.load();
		};
		clear(this.videoDesktop?.nativeElement);
		clear(this.videoMobile?.nativeElement);
	}
}
