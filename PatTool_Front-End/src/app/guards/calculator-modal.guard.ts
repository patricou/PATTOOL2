import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CalculatorModalService } from '../services/calculator-modal.service';

/**
 * The calculator is an overlay. In-app links stay on the current page.
 * A direct visit (no previous page) lands on the default route with the modal open.
 */
export const calculatorModalGuard: CanActivateFn = () => {
  const router = inject(Router);
  const modal = inject(CalculatorModalService);
  modal.open();
  const previous = router.getCurrentNavigation()?.previousNavigation;
  if (previous) {
    return false;
  }
  return router.createUrlTree(['/photos']);
};
