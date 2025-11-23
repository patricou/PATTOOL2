# Streaming Architecture Explanation

## How It Works: Server-Side Streaming + Frontend Caching

### Overview

The system uses a **hybrid approach**:
1. **Backend streams ALL events** once via Server-Sent Events (SSE)
2. **Frontend caches ALL events** in memory
3. **Frontend displays only 8 at a time** (pagination on client-side)
4. **Scrolling uses cached data** - NO backend calls

---

## Server-Side Flow

### 1. Initial Request
```
Frontend → GET /api/even/stream/{filter}
Backend → Opens MongoDB cursor
```

### 2. Streaming Process
```
Backend fetches ALL matching events from MongoDB 8.2:
  ↓
Event 1 → Send via SSE immediately
Event 2 → Send via SSE immediately  
Event 3 → Send via SSE immediately
...
Event N → Send via SSE immediately
  ↓
Send "total" count
Send "complete" signal
```

**Key Point**: Backend sends **ALL events** in one stream, not just 8!

---

## Frontend Flow

### 1. Receiving Streamed Events

```typescript
// In home-evenements.component.ts

private allStreamedEvents: Evenement[] = []; // Buffer for ALL events
public evenements: Evenement[] = []; // Only 8 displayed events

loadEventsStream() {
  this._evenementsService.streamEvents(filter, userId)
    .subscribe({
      next: (streamedEvent) => {
        if (streamedEvent.type === 'event') {
          // Add to cache (allStreamedEvents)
          this.allStreamedEvents.push(streamedEvent.data);
          
          // Display only first 8
          this.updateDisplayedEvents();
        }
      }
    });
}
```

### 2. Displaying Events (First 8)

```typescript
updateDisplayedEvents() {
  // Take only first 8 from cache
  const targetCount = Math.min(8, this.allStreamedEvents.length);
  this.evenements = this.allStreamedEvents.slice(0, targetCount);
}
```

### 3. Scrolling (Loading Next 8)

```typescript
loadNextPage() {
  const currentCount = this.evenements.length; // e.g., 8
  const totalCount = this.allStreamedEvents.length; // e.g., 50
  
  // Get next 8 from CACHE (not backend!)
  const nextEvents = this.allStreamedEvents.slice(
    currentCount,                    // Start at index 8
    currentCount + this.CARDS_PER_PAGE  // End at index 16
  );
  
  // Add to displayed events
  this.evenements.push(...nextEvents);
}
```

**Key Point**: `loadNextPage()` uses `.slice()` on the cached array - **NO backend call!**

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    INITIAL LOAD                              │
└─────────────────────────────────────────────────────────────┘

Frontend                    Backend                    MongoDB
   │                           │                          │
   │── GET /stream/* ─────────>│                          │
   │                           │── Query ────────────────>│
   │                           │                          │
   │<── SSE: event 1 ──────────│<── Cursor: event 1 ──────│
   │  (adds to allStreamedEvents[0])                       │
   │                           │                          │
   │<── SSE: event 2 ──────────│<── Cursor: event 2 ──────│
   │  (adds to allStreamedEvents[1])                       │
   │                           │                          │
   │<── SSE: event 3 ──────────│<── Cursor: event 3 ──────│
   │  (adds to allStreamedEvents[2])                       │
   │                           │                          │
   │     ... (all events) ...  │     ... (all events) ... │
   │                           │                          │
   │<── SSE: event 50 ─────────│<── Cursor: event 50 ────│
   │  (adds to allStreamedEvents[49])                      │
   │                           │                          │
   │<── SSE: complete ─────────│                          │
   │                           │                          │
   │ Display first 8:          │                          │
   │ evenements = allStreamedEvents.slice(0, 8)            │
   │                           │                          │

┌─────────────────────────────────────────────────────────────┐
│                    SCROLLING (Next 8)                       │
└─────────────────────────────────────────────────────────────┘

Frontend                    Backend                    MongoDB
   │                           │                          │
   │ User scrolls down         │                          │
   │                           │                          │
   │ loadNextPage() called     │                          │
   │                           │                          │
   │ evenements = allStreamedEvents.slice(8, 16)         │
   │ (NO backend call!)        │                          │
   │                           │                          │
   │ Display events 9-16        │                          │
   │                           │                          │

┌─────────────────────────────────────────────────────────────┐
│                    SCROLLING (Next 8 Again)                  │
└─────────────────────────────────────────────────────────────┘

Frontend                    Backend                    MongoDB
   │                           │                          │
   │ User scrolls down more    │                          │
   │                           │                          │
   │ loadNextPage() called     │                          │
   │                           │                          │
   │ evenements = allStreamedEvents.slice(16, 24)        │
   │ (NO backend call!)         │                          │
   │                           │                          │
   │ Display events 17-24       │                          │
   │                           │                          │
```

---

## Key Points

### ✅ What Happens

1. **Backend streams ALL events once** (not paginated)
2. **Frontend caches ALL events** in `allStreamedEvents[]`
3. **Frontend displays 8 at a time** from cache
4. **Scrolling = slicing cached array** (no backend call)

### ❌ What Does NOT Happen

- ❌ Backend does NOT send only 8 events
- ❌ Frontend does NOT call backend on scroll
- ❌ Frontend does NOT use pagination API

---

## Memory Usage

### Backend
- **Low memory**: Streams one event at a time
- **MongoDB cursor**: Fetches in batches, but processes one by one

### Frontend
- **All events in memory**: `allStreamedEvents[]` contains ALL events
- **Displayed events**: `evenements[]` contains only 8-16 at a time
- **Memory usage**: O(n) where n = total number of events

### Example
- 100 events total
- `allStreamedEvents.length = 100` (all cached)
- `evenements.length = 8` (only displayed)
- Scrolling: `evenements.length = 16, 24, 32...` (from cache)

---

## Benefits

1. **Fast scrolling**: No network latency (uses cache)
2. **Smooth UX**: Instant display of next 8 events
3. **Offline-ready**: All data already loaded
4. **Search/filter ready**: Can filter cached data instantly

## Trade-offs

1. **Memory usage**: All events loaded in memory
2. **Initial load time**: Must wait for all events to stream
3. **Large datasets**: May use significant memory for 1000+ events

---

## Code References

### Backend Streaming
- `EvenementRestController.streamEvenements()` - Streams all events
- Sends events one by one via SSE
- Sorts by date (most recent first)

### Frontend Caching
- `allStreamedEvents: Evenement[]` - Cache for all events
- `evenements: Evenement[]` - Displayed events (8 at a time)
- `loadNextPage()` - Slices from cache (no backend call)

### Frontend Streaming
- `EvenementsService.streamEvents()` - Receives SSE stream
- `loadEventsStream()` - Processes streamed events
- `updateDisplayedEvents()` - Updates displayed events from cache

---

## Summary

**Question**: Does scrolling call the backend again?

**Answer**: **NO!** 

- Backend streams ALL events once
- Frontend caches ALL events
- Scrolling just displays more from the cache
- No backend calls on scroll

This is a **"stream once, cache all, paginate client-side"** approach.


