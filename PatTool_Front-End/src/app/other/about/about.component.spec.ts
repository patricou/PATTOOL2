import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { AboutComponent } from './about.component';

describe('HomeMapsComponent', () => {
  let component: AboutComponent;
  let fixture: ComponentFixture<AboutComponent>;

  beforeEach(waitForAsync(() => {
    TestBed.configureTestingModule({
      imports: [AboutComponent, TranslateModule.forRoot()]
    })
      .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(AboutComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should use absolute feature routes so tiles do not stay under /maps', () => {
    expect(component.featureLinks.length).toBeGreaterThan(0);
    for (const feat of component.featureLinks) {
      expect(feat.route.startsWith('/'))
        .withContext(`${feat.labelKey} must be absolute, got ${feat.route}`)
        .toBeTrue();
    }
  });
});
