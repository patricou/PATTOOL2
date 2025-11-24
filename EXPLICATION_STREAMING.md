# Streaming and Scrolling Explanation

## 🎯 Quick Summary

**Streaming sends ALL events on initial load (JSON metadata only, NO binary files).**
**Scrolling does NOT call the backend for events, but it loads image thumbnails on-demand.**

---

## 📥 Phase 1: Initial Load (When you load the page)

### What the Frontend does:
```typescript
// In home-evenements.component.ts
loadEventsStream() {
  // Calls backend with SSE (Server-Sent Events)
  this._evenementsService.streamEvents(filter, userId)
    .subscribe({
      next: (streamedEvent) => {
        if (streamedEvent.type === 'event') {
          // ✅ Adds each event to cache (ALL events)
          this.allStreamedEvents.push(streamedEvent.data);
          
          // ✅ Displays only the first 8
          this.updateDisplayedEvents();
        }
      }
    });
}
```

### What the Backend does:
```java
// In EvenementRestController.java
@GetMapping("/stream/{evenementName}")
public SseEmitter streamEvenements(...) {
  // 1. Opens a MongoDB cursor for ALL events
  // 2. For each event found:
  //    - Sends immediately via SSE
  //    - No waiting, sends as they come
  // 3. Sends the total count
  // 4. Sends the "complete" signal
}
```

### 🔍 What you see in the network console:

```
GET /api/even/stream/* 
  ↓
SSE Event: event (event 1)
SSE Event: event (event 2)
SSE Event: event (event 3)
...
SSE Event: event (event 50)
SSE Event: total (50)
SSE Event: complete
```

**The backend sends ALL events in a single SSE connection!**

### ⚠️ IMPORTANT: What is sent via SSE?

**ONLY JSON metadata is sent via SSE, NOT binary files/images!**

```java
// EvenementRestController.java line 164
String eventJson = objectMapper.writeValueAsString(event);
emitter.send(SseEmitter.event().name("event").data(eventJson));
```

**What IS included in the JSON:**
- ✅ Event metadata (name, dates, comments, etc.)
- ✅ File references (`FileUploaded` objects with `fieldId`, `fileName`, `fileType`)
- ✅ Member references
- ✅ URLs and other text data

**What is NOT included:**
- ❌ **NO binary file data** (images, videos, documents)
- ❌ **NO image thumbnails**
- ❌ **NO large files**

**Where are files stored?**
- Files are stored separately in **MongoDB GridFS**
- Files are loaded **on-demand** via separate HTTP calls: `GET /api/file/{fileId}`
- Thumbnails are loaded when needed (on scroll or when displayed)

**This is why:**
1. SSE stream is fast - only small JSON objects
2. Large files don't block the initial load
3. Files are loaded progressively as needed

---

## 📜 Phase 2: When you scroll (Loading next page)

### What the Frontend does:
```typescript
// In home-evenements.component.ts - line 1145
private loadNextPage(): void {
  const currentCount = this.evenements.length; // ex: 8
  const totalCount = this.allStreamedEvents.length; // ex: 50
  
  // ✅ Gets the next 8 from CACHE (no backend!)
  const nextEvents = this.allStreamedEvents.slice(currentCount, currentCount + 8);
  
  // ✅ Adds to display
  this.evenements.push(...nextEvents);
  
  // ⚠️ BUT: Loads image thumbnails (backend calls!)
  nextEvents.forEach(event => {
    this.loadFileThumbnails(event); // ← This makes backend calls
  });
}
```

### 🔍 What you see in the network console when scrolling:

**NO calls for events!** ✅
```typescript
// Events come from cache
this.allStreamedEvents.slice(8, 16) // No HTTP call
```

**BUT calls for thumbnails** ⚠️
```
GET /api/file/{fileId1}  ← Thumbnail image 1
GET /api/file/{fileId2}  ← Thumbnail image 2
GET /api/file/{fileId3}  ← Thumbnail image 3
...
```

These calls are made in `loadFileThumbnails()`:
```typescript
// Line 1519
private loadFileThumbnails(evenement: Evenement): void {
  imageFiles.forEach(file => {
    // ⚠️ Backend call for each thumbnail
    this._fileService.getFile(file.fieldId).subscribe(...)
  });
}
```

---

## 📊 Complete Flow Diagram

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
   │  → allStreamedEvents[0]                               │
   │  → Displays if index < 8                              │
   │                           │                          │
   │<── SSE: event 2 ──────────│<── Cursor: event 2 ──────│
   │  → allStreamedEvents[1]                               │
   │  → Displays if index < 8                              │
   │                           │                          │
   │     ... (all events) ...                              │
   │                           │                          │
   │<── SSE: event 50 ─────────│<── Cursor: event 50 ────│
   │  → allStreamedEvents[49]                              │
   │                           │                          │
   │<── SSE: complete ─────────│                          │
   │                           │                          │

┌─────────────────────────────────────────────────────────────┐
│                    SCROLL (Next Page)                        │
└─────────────────────────────────────────────────────────────┘

Frontend                    Backend                    MongoDB
   │                           │                          │
   │ User scrolls down         │                          │
   │                           │                          │
   │ loadNextPage() called     │                          │
   │                           │                          │
   │ evenements = allStreamedEvents.slice(8, 16)         │
   │ (✅ NO backend call for events)                       │
   │                           │                          │
   │ BUT:                      │                          │
   │ loadFileThumbnails() ────>│ GET /api/file/{id1}      │
   │                           │                          │
   │ loadFileThumbnails() ────>│ GET /api/file/{id2}      │
   │                           │                          │
   │ loadFileThumbnails() ────>│ GET /api/file/{id3}      │
   │                           │                          │
```

---

## ✅ Key Points to Remember

### 1. Streaming sends EVERYTHING at the start
- **All events** are sent via SSE in a single connection
- Backend does NOT paginate events
- It's a **continuous stream** until all events are sent

### 2. Scroll does NOT reload events
- Events come from the `allStreamedEvents[]` cache
- The `loadNextPage()` method just does a `.slice()` on the array
- **No backend calls for event data**

### 3. BUT Scroll loads Thumbnails
- Each event can have images/thumbnails
- These thumbnails are loaded via `loadFileThumbnails()`
- This makes backend calls: `GET /api/file/{fileId}`
- **This is what you see in the network console!**

---

## 🔍 Why this architecture?

### ✅ Advantages
1. **Ultra-fast scrolling**: No network latency for events
2. **Data already available**: All events are cached
3. **Instant filtering**: Can filter in cache without backend
4. **Better UX**: Immediate display when scrolling

### ⚠️ Trade-offs
1. **Memory**: All events are in memory
2. **Initial load time**: Must wait for all events
3. **Thumbnails loaded progressively**: Images are loaded on scroll (normal for optimization)

---

## 🐛 If you see backend calls on scroll

This is **normal**! These are image thumbnails being loaded, not events.

**Verification:**
- Scroll calls are probably to `/api/file/{fileId}`
- These are event thumbnails
- Events themselves come from cache

---

## 📝 Summary in 3 points

1. **Initial streaming** = Sends ALL events via SSE (JSON metadata only, NO binary files/images)
2. **Scroll** = Gets events from cache (no backend call for event data)
3. **Thumbnails** = Loaded on scroll via backend calls `/api/file/{id}` (normal - files are stored separately in GridFS)

---

## 🔧 Code References

### Backend - Streaming
- **File**: `EvenementRestController.java`
- **Method**: `streamEvenements()` (line 73)
- **What it does**: Streams all events one by one via SSE

### Frontend - Receiving Stream
- **File**: `home-evenements.component.ts`
- **Method**: `loadEventsStream()` (line 683)
- **What it does**: Receives events and puts them in `allStreamedEvents[]`

### Frontend - Scroll
- **File**: `home-evenements.component.ts`
- **Method**: `loadNextPage()` (line 1145)
- **What it does**: Gets next 8 from `allStreamedEvents[]` (line 1176)

### Frontend - Thumbnails
- **File**: `home-evenements.component.ts`
- **Method**: `loadFileThumbnails()` (line 1497)
- **What it does**: Calls backend for each thumbnail (line 1519)
