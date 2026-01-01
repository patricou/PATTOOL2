import { Directive, ElementRef, EventEmitter, HostListener, Output, Renderer2, OnInit, OnDestroy } from '@angular/core';

/**
 * Directive to handle wheel events with explicit passive: false to avoid browser warnings
 * while still allowing preventDefault() to work correctly.
 */
@Directive({
  selector: '[appWheelNonPassive]',
  standalone: true
})
export class WheelNonPassiveDirective implements OnInit, OnDestroy {
  @Output() wheelEvent = new EventEmitter<WheelEvent>();
  
  private wheelHandler?: (event: WheelEvent) => void;

  constructor(
    private el: ElementRef<HTMLElement>,
    private renderer: Renderer2
  ) {}

  ngOnInit(): void {
    // Setup listener programmatically with explicit passive: false
    // This avoids the browser warning while still allowing preventDefault()
    this.wheelHandler = (event: WheelEvent) => {
      this.wheelEvent.emit(event);
    };
    
    // Use addEventListener with passive: false explicitly
    this.el.nativeElement.addEventListener('wheel', this.wheelHandler, { passive: false, capture: false });
  }

  ngOnDestroy(): void {
    if (this.wheelHandler) {
      this.el.nativeElement.removeEventListener('wheel', this.wheelHandler);
      this.wheelHandler = undefined;
    }
  }
}
