import { Injectable } from '@angular/core';

export type HomeCardState = 'loading' | 'ready' | 'empty' | 'error';

export interface HomeAgendaItem {
	title: string;
	when: string;
	owner: string;
	kindLabel: string;
	route: string[];
	queryParams: Record<string, string> | null;
	thumbId: string;
	thumb: string;
	daysLeft: number | null;
}

export interface HomeTaskItem {
	title: string;
	listName: string;
	listId: string;
	itemId: string;
	when: string;
	assignee: string;
	owner: string;
	overdue: boolean;
}

export interface HomeNewsItem {
	title: string;
	url: string;
	source: string;
	image: string;
	when: string;
}

export type HomeNewsProvider = 'newsdata' | 'newsapi' | 'rss';

/** Last home dashboard shown in this browser session. Survives leaving the page, not a full reload. */
export interface HomeDashboardSnapshot {
	lang: string;
	weatherState: HomeCardState;
	weatherTemp: string;
	weatherPlace: string;
	weatherDesc: string;
	weatherFeels: string;
	weatherHumidity: string;
	weatherLat: number | null;
	weatherLon: number | null;
	weatherAltitude: number | null;
	weatherRegion: 'france' | 'switzerland';
	weatherClim: boolean;
	weatherTempC: number | null;
	weatherObservedAt: string;
	userAddress: string;
	userLabel: string;
	userLogin: string;
	userSeen: string;
	agendaState: HomeCardState;
	activities: HomeAgendaItem[];
	appointments: HomeAgendaItem[];
	agendaExtra: number;
	taskState: HomeCardState;
	tasks: HomeTaskItem[];
	newsState: HomeCardState;
	news: HomeNewsItem[];
	newsProvider: HomeNewsProvider;
}

@Injectable({ providedIn: 'root' })
export class HomeDashboardCacheService {
	snapshot: HomeDashboardSnapshot | null = null;
	/** Bumped by a full reload so an older visit cannot overwrite the cache. */
	epoch = 0;
	/** Activity photo object URLs. Kept here so leaving the page does not revoke them. */
	readonly activityThumbs = new Map<string, string>();
}
