import { Directive, ElementRef, NgZone, OnDestroy, AfterViewInit, Optional } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

/**
 * Ajuste scale() pour que la rangée (inline-flex nowrap) tienne dans la largeur du parent,
 * sans scroll ni retour à la ligne. Met à jour --row-fit-scale et la min-height du parent.
 */
@Directive({
    selector: '[ptScaleRowToFit]',
    standalone: true
})
export class ScaleRowToFitDirective implements AfterViewInit, OnDestroy {
    private ro?: ResizeObserver;
    private mo?: MutationObserver;
    private onWinResize?: () => void;
    private langSub?: Subscription;

    constructor(
        private el: ElementRef<HTMLElement>,
        private zone: NgZone,
        @Optional() private translate?: TranslateService
    ) {}

    ngAfterViewInit(): void {
        const inner = this.el.nativeElement;
        const parent = inner.parentElement;
        if (!parent) {
            return;
        }

        const update = () => {
            this.zone.runOutsideAngular(() => {
                requestAnimationFrame(() => {
                    if (!parent.isConnected || !inner.isConnected) {
                        return;
                    }
                    const pw = parent.clientWidth;
                    const iw = inner.scrollWidth;
                    const ih = inner.offsetHeight;
                    if (pw <= 0 || iw <= 0) {
                        return;
                    }
                    const s = Math.min(1, pw / iw);
                    parent.style.setProperty('--row-fit-scale', String(s));
                    parent.style.minHeight = `${Math.max(28, Math.ceil(ih * s))}px`;
                });
            });
        };

        this.ro = new ResizeObserver(() => update());
        this.ro.observe(parent);
        this.ro.observe(inner);

        this.mo = new MutationObserver(() => update());
        this.mo.observe(inner, { subtree: true, childList: true, attributes: true, characterData: true });

        this.onWinResize = () => update();
        window.addEventListener('resize', this.onWinResize);

        setTimeout(update, 0);
        setTimeout(update, 250);

        if (this.translate) {
            this.langSub = this.translate.onLangChange.subscribe(() => {
                setTimeout(update, 0);
            });
        }
    }

    ngOnDestroy(): void {
        this.ro?.disconnect();
        this.mo?.disconnect();
        this.langSub?.unsubscribe();
        if (this.onWinResize) {
            window.removeEventListener('resize', this.onWinResize);
        }
    }
}
