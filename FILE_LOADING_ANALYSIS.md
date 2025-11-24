# File Loading Analysis - What Gets Loaded Per Event Card?

## 📋 Summary

**Good news:** Files are NOT loaded for all streamed events, only for displayed events.

**But:** For each displayed event card, multiple files may be loaded if they have "thumbnail" in their name.

---

## ✅ What Happens During Streaming (Initial Load)

### Phase 1: Streaming Metadata (Fast)
```typescript
// When event is received via SSE
allStreamedEvents.push(streamedEvent.data);  // Only JSON metadata, no files!
```

**What is loaded:**
- ✅ Event metadata (name, dates, etc.)
- ✅ File metadata (FileUploaded objects with fieldId, fileName, fileType)
- ❌ **NO actual files/images are loaded**

**Network calls:** Only 1 SSE connection for all events

---

## ⚠️ What Happens When Event is Displayed (Per Card)

### Phase 2: Displaying Event Card (Potentially Slow)

When an event is added to the display (line 1128-1130):

```typescript
// In updateDisplayedEvents() - line 1128
this.queueThumbnailLoad(event);           // Loads 1 main thumbnail
this.loadFileThumbnails(event);          // Loads ALL files with "thumbnail" in name
```

### 1. Main Thumbnail Loading (`queueThumbnailLoad`)

**What it loads:**
- ✅ **1 file only** - the first file with "thumbnail" in its name
- Used to display the main image on the event card

**Network calls:** 1 GET request per displayed event card
```
GET /api/file/{thumbnailFileId}
```

### 2. File Thumbnails Loading (`loadFileThumbnails`) ⚠️ **THIS IS THE PROBLEM!**

**What it loads:**
- ⚠️ **ALL files** that are images AND have "thumbnail" in the filename

**Code:**
```typescript
// Line 1503-1507
const imageFiles = evenement.fileUploadeds.filter(file => 
  this.isImageFile(file.fileName) && 
  file.fileName && 
  file.fileName.toLowerCase().includes('thumbnail')
);

// Line 1509 - For EACH matching file:
imageFiles.forEach(file => {
  this._fileService.getFile(file.fieldId).subscribe(...);  // Backend call!
});
```

**Network calls:** Multiple GET requests per displayed event card
```
GET /api/file/{thumbnailFileId1}
GET /api/file/{thumbnailFileId2}
GET /api/file/{thumbnailFileId3}
...
GET /api/file/{thumbnailFileIdN}
```

---

## 🔴 Performance Problem

### Example Scenario

**Event with 20 files, 5 have "thumbnail" in name:**
- 1 main thumbnail → 1 backend call
- 5 thumbnail files → 5 backend calls
- **Total: 6 backend calls per event card**

**For 8 displayed event cards:**
- 8 × 6 = **48 backend calls** just for thumbnails!

**If each thumbnail is 100 KB:**
- 48 × 100 KB = **4.8 MB** downloaded
- Even on fast connection, this takes time!

### Why This Is Slow

1. **Multiple sequential/parallel requests** per event
2. **No batching** - each file is loaded separately
3. **All thumbnail files** are loaded even if not needed for the card display
4. **Network overhead** - each request has HTTP headers, connection overhead

---

## 📊 Current Loading Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    STREAMING PHASE                           │
└─────────────────────────────────────────────────────────────┘

Event 1 → JSON metadata only (no files)
Event 2 → JSON metadata only (no files)
...
Event 50 → JSON metadata only (no files)

┌─────────────────────────────────────────────────────────────┐
│              DISPLAY PHASE (First 8 Events)                  │
└─────────────────────────────────────────────────────────────┘

Event 1 Card:
  ├─ Main thumbnail → GET /api/file/{id1}
  ├─ Thumbnail file 1 → GET /api/file/{id2}  ← Unnecessary?
  ├─ Thumbnail file 2 → GET /api/file/{id3}  ← Unnecessary?
  └─ Thumbnail file N → GET /api/file/{idN}  ← Unnecessary?

Event 2 Card:
  ├─ Main thumbnail → GET /api/file/{id1}
  ├─ Thumbnail files... → Multiple GET requests
  ...

Total: 8 cards × (1 + N thumbnails) = Many requests!
```

---

## ✅ Recommended Optimizations

### Option 1: Load Only Main Thumbnail for Cards (Recommended)

Only load the main thumbnail for card display. Load other thumbnails on-demand.

```typescript
// Remove or conditionally call loadFileThumbnails
this.queueThumbnailLoad(event);  // Keep this - loads main thumbnail
// this.loadFileThumbnails(event);  // Remove or load on-demand
```

**Benefits:**
- 8 cards × 1 request = **8 requests** instead of 48
- Much faster initial load
- Other thumbnails can be loaded when user expands card

### Option 2: Lazy Load File Thumbnails

Only load file thumbnails when user opens the files modal:

```typescript
// Only load when modal opens
public openFilesModal(evenement: Evenement) {
  // Load thumbnails only when needed
  this.loadFileThumbnails(evenement);
  this.modalService.open(this.filesModal, ...);
}
```

### Option 3: Batch Thumbnail Requests

Load multiple thumbnails in a single batch request:

```typescript
// Backend: New endpoint
GET /api/files/batch?ids={id1,id2,id3,...,idN}

// Frontend: Single request instead of multiple
this._fileService.getFilesBatch(thumbnailIds).subscribe(...);
```

### Option 4: Use Thumbnail Cache

Cache thumbnails globally to avoid reloading:

```typescript
// Already partially implemented with fileThumbnailsCache
// But could be improved with localStorage/IndexedDB persistence
```

---

## 📝 Answer to Your Question

**"Do you load all the files (and images) for each card at this moment?"**

### Short Answer:
**No, not all files. But ALL files with "thumbnail" in the name are loaded for each displayed card.**

### Detailed Answer:

1. **During streaming:**
   - ❌ No files are loaded
   - ✅ Only metadata is streamed

2. **When event is displayed:**
   - ✅ 1 main thumbnail (for card image)
   - ⚠️ **ALL files with "thumbnail" in filename** (may be many!)
   - ❌ Other files are NOT loaded (only loaded when modal opens)

3. **Problem:**
   - If an event has 10 files with "thumbnail" in name
   - All 10 are loaded when the card is displayed
   - This causes many backend calls per card

---

## 🎯 Recommendation

**Remove or optimize `loadFileThumbnails()` call in `updateDisplayedEvents()`:**

```typescript
// Current (line 1128-1130):
this.queueThumbnailLoad(event);        // Keep - loads main thumbnail
this.loadFileThumbnails(event);        // Remove or make conditional

// Better:
this.queueThumbnailLoad(event);        // Keep - for card display
// Load file thumbnails only when files modal opens (line 1485)
```

This would reduce initial load from **48 requests** to **8 requests** (87% reduction)!

