/** Affichage type quartz : nombre de jours sur 3 chiffres (ex. 042). */
export function formatDaysUntilLcd(days: number): string {
	return String(days).padStart(3, '0');
}

/** Chiffres pour l’affichage 7 segments (3 cellules). */
export function getDaysUntilLcdDigits(days: number): string[] {
	return formatDaysUntilLcd(days).split('');
}

function parseEventStartDateTime(beginEventDate: Date | string | null | undefined, startHour?: string | null): Date | null {
	if (!beginEventDate) {
		return null;
	}
	const start = beginEventDate instanceof Date ? new Date(beginEventDate.getTime()) : new Date(beginEventDate);
	if (Number.isNaN(start.getTime())) {
		return null;
	}
	const hour = (startHour || '').trim();
	const match = /^(\d{1,2}):(\d{2})/.exec(hour);
	if (match) {
		start.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0);
	}
	return start;
}

/** Jours calendaires avant le début si la date/heure de début est dans le futur ; sinon `null`. */
export function getDaysUntilEventStart(
	beginEventDate: Date | string | null | undefined,
	startHour?: string | null
): number | null {
	const start = parseEventStartDateTime(beginEventDate, startHour);
	if (!start) {
		return null;
	}
	const now = new Date();
	if (start.getTime() <= now.getTime()) {
		return null;
	}
	const startDay = new Date(start);
	startDay.setHours(0, 0, 0, 0);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const diffDays = Math.round((startDay.getTime() - today.getTime()) / 86_400_000);
	return diffDays > 0 ? diffDays : null;
}
