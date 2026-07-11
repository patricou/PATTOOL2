import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subscription, timer, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface MongoHealthStatus {
  status: 'UP' | 'DOWN';
  message?: string | null;
  host?: string;
  port?: number;
  database?: string;
}

export type MongoHealthUiState = 'unknown' | 'up' | 'down';

@Injectable({ providedIn: 'root' })
export class MongoHealthService implements OnDestroy {
  private readonly pollMs = 20_000;
  private readonly url = environment.API_URL + 'health/mongodb';

  private readonly stateSubject = new BehaviorSubject<MongoHealthUiState>('unknown');
  private readonly detailSubject = new BehaviorSubject<MongoHealthStatus | null>(null);
  private pollSub: Subscription | null = null;

  readonly state$ = this.stateSubject.asObservable();
  readonly detail$ = this.detailSubject.asObservable();

  constructor(private http: HttpClient) {}

  startMonitoring(): void {
    if (this.pollSub) {
      return;
    }
    this.pollSub = timer(0, this.pollMs)
      .pipe(switchMap(() => this.fetchOnce()))
      .subscribe();
  }

  checkNow(): void {
    this.fetchOnce().subscribe();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  private fetchOnce() {
    return this.http.get<MongoHealthStatus>(this.url).pipe(
      tap((body) => this.applyResponse(body)),
      catchError(() => {
        this.stateSubject.next('unknown');
        this.detailSubject.next(null);
        return of(null);
      })
    );
  }

  private applyResponse(body: MongoHealthStatus | null | undefined): void {
    if (!body) {
      return;
    }
    this.detailSubject.next(body);
    this.stateSubject.next(body.status === 'UP' ? 'up' : 'down');
  }
}
