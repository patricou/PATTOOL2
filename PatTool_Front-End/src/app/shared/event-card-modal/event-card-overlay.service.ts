import { ApplicationRef, ComponentRef, EnvironmentInjector, Injectable, createComponent, inject } from '@angular/core';
import type { EventCardOverlayComponent } from './event-card-overlay.component';

/**
 * Opens the event card (fiche événement) above the current page.
 * The component is loaded on demand so notes and the event card do not import each other at startup.
 */
@Injectable({ providedIn: 'root' })
export class EventCardOverlayService {
    private readonly appRef = inject(ApplicationRef);
    private readonly injector = inject(EnvironmentInjector);
    private ref: ComponentRef<EventCardOverlayComponent> | null = null;
    private opening = false;

    open(eventId: string | null | undefined): void {
        const id = (eventId || '').trim();
        if (!id || this.opening) {
            return;
        }
        this.opening = true;
        void import('./event-card-overlay.component')
            .then(({ EventCardOverlayComponent }) => {
                this.opening = false;
                this.mount(EventCardOverlayComponent, id);
            })
            .catch(err => {
                this.opening = false;
                console.error('Event card overlay failed to open', err);
            });
    }

    isOpen(): boolean {
        return this.ref !== null;
    }

    /**
     * Puts the newest Bootstrap modal above the event card (host z-index 2000).
     * Optional markerClass selects a windowClass; otherwise the latest ngb window is raised.
     */
    raiseLatestModalAboveCard(markerClass?: string): void {
        if (!this.isOpen()) {
            return;
        }
        const marker = (markerClass || '').trim().split(/\s+/).filter(Boolean)[0];
        let win: HTMLElement | undefined;
        if (marker) {
            const marked = document.querySelectorAll(`ngb-modal-window.${marker}`);
            win = marked[marked.length - 1] as HTMLElement | undefined;
        }
        if (!win) {
            const all = document.querySelectorAll('ngb-modal-window');
            win = all[all.length - 1] as HTMLElement | undefined;
        }
        if (win) {
            win.style.setProperty('z-index', '2200', 'important');
        }
        const backdrops = document.querySelectorAll('ngb-modal-backdrop');
        const backdrop = backdrops[backdrops.length - 1] as HTMLElement | undefined;
        if (backdrop) {
            backdrop.style.setProperty('z-index', '2150', 'important');
        }
    }

    close(): void {
        const ref = this.ref;
        if (!ref) {
            return;
        }
        this.ref = null;
        this.appRef.detachView(ref.hostView);
        ref.destroy();
    }

    private mount(component: typeof import('./event-card-overlay.component').EventCardOverlayComponent, eventId: string): void {
        this.close();
        const ref = createComponent(component, {
            environmentInjector: this.injector
        });
        const host = ref.location.nativeElement as HTMLElement;
        host.style.zIndex = '2000';
        document.body.appendChild(host);
        this.appRef.attachView(ref.hostView);
        ref.setInput('eventId', eventId);
        const sub = ref.instance.closed.subscribe(() => {
            sub.unsubscribe();
            this.close();
        });
        ref.changeDetectorRef.detectChanges();
        this.ref = ref;
    }
}
