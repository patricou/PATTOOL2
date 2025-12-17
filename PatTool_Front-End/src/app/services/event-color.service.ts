import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class EventColorService {
  private eventColors: Map<string, { r: number; g: number; b: number }> = new Map();

  /**
   * Store the calculated color for an event
   */
  setEventColor(eventId: string, color: { r: number; g: number; b: number }): void {
    this.eventColors.set(eventId, color);
  }

  /**
   * Get the stored color for an event
   */
  getEventColor(eventId: string): { r: number; g: number; b: number } | null {
    return this.eventColors.get(eventId) || null;
  }

  /**
   * Clear the stored color for an event
   */
  clearEventColor(eventId: string): void {
    this.eventColors.delete(eventId);
  }

  /**
   * Clear all stored colors
   */
  clearAll(): void {
    this.eventColors.clear();
  }
}

