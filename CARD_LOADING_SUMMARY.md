# Card Loading System - How It Works

## Overview

The card loading system uses a **three-tier architecture** with proactive caching to provide smooth infinite scrolling. Cards are loaded in batches, cached in advance, and displayed incrementally as the user scrolls.

---

## Architecture: Three Tiers

```
┌─────────────────────────────────────┐
│   VISIBLE (8 cards)                 │  ← Currently displayed
│   What user sees on screen          │
└─────────────────────────────────────┘
           ↓ (moves 4 at a time)
┌─────────────────────────────────────┐
│   BUFFER (12 cards)                 │  ← Pre-loaded cache
│   Ready to display instantly        │
└─────────────────────────────────────┘
           ↓ (loads when < 9)
┌─────────────────────────────────────┐
│   ALL LOADED (all fetched events)    │  ← Complete history
│   Tracks everything loaded so far   │
└─────────────────────────────────────┘
```

---

## Initial Load (First Page)

### Step 1: Load 20 Events
- **Request**: Loads 20 events from server (8 visible + 12 buffer)
- **Method**: `loadInitialEvents()`
- **API Call**: `getEvents(searchString, pageToLoad, 20, userId)`

### Step 2: Split into Visible and Buffer
```
20 Events Loaded
├── First 8 events  → visibleEvenements (displayed immediately)
└── Next 12 events  → bufferedEvenements (cached for later)
```

### Step 3: Load Thumbnails
- **Visible cards**: Thumbnails loaded in parallel immediately
- **Buffer cards**: Thumbnails preloaded in parallel (all 12 at once)
- **Method**: `loadThumbnailsInParallel()` and `preloadThumbnailsForBufferedEvents()`

### Step 4: Setup Scroll Observer
- **IntersectionObserver** watches an anchor element at the bottom
- **Trigger distance**: 2000px before anchor is visible (early loading)
- **Method**: `setupInfiniteScrollObserver()`

---

## Scrolling & Infinite Load

### When User Scrolls Down

#### Step 1: Observer Detects Scroll
- **IntersectionObserver** fires when anchor element becomes visible (or within 2000px)
- **Action**: Calls `loadMoreFromBuffer()`

#### Step 2: Move Cards from Buffer to Visible
```
Buffer: [Card9, Card10, Card11, Card12, Card13, Card14, Card15, Card16, ...]
         ↓ Move 4 cards
Visible: [Card1-8] + [Card9, Card10, Card11, Card12]
Buffer:  [Card13, Card14, Card15, Card16, ...]  ← Now has 8 cards
```

- **Moves**: 4 cards at a time (`SCROLL_INCREMENT = 4`)
- **Thumbnails**: Already loaded (preloaded in buffer)
- **Display**: Immediate, no waiting

#### Step 3: Check Cache Level
```
If buffer.length < 9:
    → Trigger loadNextPage() to refill buffer
```

---

## Cache Refill (Proactive Loading)

### Trigger Condition
- **When**: Buffer drops below 9 cards
- **Action**: Automatically loads more events to refill buffer to 12

### Load Process

#### Step 1: Calculate How Many to Load
```typescript
currentBufferSize = 8  // After moving 4 cards, buffer has 8 left
eventsToLoad = MIN_BUFFER_SIZE - currentBufferSize
eventsToLoad = 12 - 8 = 4  // Load 4 more to reach 12
```

#### Step 2: Load from Server
- **Request**: `getEvents(searchString, pageNumber, 4, userId)`
- **Method**: `loadNextPage()`
- **Adds to**: `bufferedEvenements` and `allLoadedEvenements`

#### Step 3: Preload Thumbnails
- **Immediate**: All new buffer cards get thumbnails loaded in parallel
- **No delay**: Thumbnails ready before user scrolls to them

#### Step 4: Check Again
- After loading, if buffer still < 9, triggers another load
- Continues until buffer has 12 cards OR no more events available

---

## Complete Flow Example

### Scenario: User Scrolls Through 20 Cards

```
┌─────────────────────────────────────────────────────────────┐
│ INITIAL STATE                                                │
├─────────────────────────────────────────────────────────────┤
│ Visible: [1, 2, 3, 4, 5, 6, 7, 8]                          │
│ Buffer:  [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]   │
│ All:     [1-20]                                             │
└─────────────────────────────────────────────────────────────┘
                    ↓ User scrolls
┌─────────────────────────────────────────────────────────────┐
│ AFTER FIRST SCROLL (4 cards moved)                          │
├─────────────────────────────────────────────────────────────┤
│ Visible: [1-8, 9, 10, 11, 12]                              │
│ Buffer:  [13, 14, 15, 16, 17, 18, 19, 20]  ← 8 cards       │
│ All:     [1-20]                                             │
│                                                              │
│ ⚠️ Buffer < 9 → TRIGGER LOAD                                │
│ Loads: 4 more events → Buffer now has 12                   │
└─────────────────────────────────────────────────────────────┘
                    ↓ User scrolls again
┌─────────────────────────────────────────────────────────────┐
│ AFTER SECOND SCROLL (4 more cards moved)                    │
├─────────────────────────────────────────────────────────────┤
│ Visible: [1-12, 13, 14, 15, 16]                            │
│ Buffer:  [17, 18, 19, 20, 21, 22, 23, 24]  ← 8 cards       │
│ All:     [1-24]                                             │
│                                                              │
│ ⚠️ Buffer < 9 → TRIGGER LOAD                                │
│ Loads: 4 more events → Buffer now has 12                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Mechanisms

### 1. IntersectionObserver
```typescript
rootMargin: '2000px 0px 0px 0px'  // Triggers 2000px before anchor visible
threshold: [0]                      // Triggers as soon as any part is visible
```

**Purpose**: Detects when user is approaching bottom of page
**Benefit**: Loads content before user reaches it (seamless experience)

### 2. Request Token System
```typescript
feedRequestToken++  // Incremented on each new request
```

**Purpose**: Prevents race conditions
**How**: Each request checks if token matches before processing
**Benefit**: Cancels stale requests automatically

### 3. Duplicate Prevention
- Checks `allLoadedEvenements`
- Checks `visibleEvenements`
- Checks `bufferedEvenements`
- Checks first event (special case)

**Purpose**: Prevents showing same card twice
**Method**: `isEventAlreadyLoaded()`

### 4. Thumbnail Caching
- **Shared cache**: Between `home-evenements` and `element-evenement` components
- **Blob URLs**: Created once, reused
- **Cleanup**: Automatic on component destroy

---

## Loading States

### State Flags
- `isLoading`: Main spinner (initial load)
- `isLoadingNextPage`: Loading more events (cache refill)
- `hasMoreEvents`: Whether more events available from server

### State Flow
```
User Action → Check Buffer → If < 9:
    ↓
Set isLoadingNextPage = true
    ↓
Load from Server
    ↓
Add to Buffer
    ↓
Preload Thumbnails
    ↓
Set isLoadingNextPage = false
    ↓
Check Buffer Again (if still < 9, repeat)
```

---

## Performance Optimizations

### 1. Parallel Operations
- **Thumbnails**: All loaded simultaneously using `forkJoin`
- **Display & Load**: Happen independently (non-blocking)

### 2. Proactive Caching
- **Always maintains**: 12 cards ready in buffer
- **Triggers early**: When buffer drops to 8 (before it's empty)
- **Result**: User never waits for loading

### 3. Incremental Display
- **4 cards at a time**: Smooth transitions
- **Already loaded**: Thumbnails ready before display
- **No flicker**: Seamless user experience

### 4. Memory Management
- **Blob URL cleanup**: Prevents memory leaks
- **Unused thumbnail cleanup**: Removes old thumbnails
- **Subscription cleanup**: Proper RxJS cleanup

---

## Edge Cases Handled

### 1. No More Events
- `hasMoreEvents = false`
- Observer disconnected
- No more loads triggered

### 2. Network Errors
- Error handlers reset flags
- Scroll unblocked
- User can retry

### 3. Stuck Loading State
- 30-second timeout protection
- Checks subscription state
- Auto-reset if needed

### 4. Rapid Scrolling
- Multiple scroll events handled
- Observer debounced
- Only loads when needed

### 5. Filter Changes
- `feedRequestToken` incremented
- Old requests cancelled
- Fresh load started

---

## Summary: The Complete Picture

```
┌──────────────────────────────────────────────────────────────┐
│                    USER SCROLLS DOWN                          │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│  IntersectionObserver detects anchor visible                │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│  loadMoreFromBuffer() called                                 │
│  - Moves 4 cards from buffer to visible                     │
│  - Displays immediately (thumbnails already loaded)        │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│  Check: buffer.length < 9?                                 │
│  YES → loadNextPage()                                        │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│  loadNextPage() executes                                     │
│  - Calculates: 12 - currentBufferSize = eventsToLoad         │
│  - Loads from server                                         │
│  - Adds to buffer                                            │
│  - Preloads thumbnails in parallel                          │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│  Buffer refilled to 12 cards                                 │
│  Ready for next scroll                                       │
└──────────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

1. **Three-tier system**: Visible (8) → Buffer (12) → All Loaded
2. **Proactive loading**: Triggers when buffer < 9, not when empty
3. **Parallel operations**: Thumbnails and data load simultaneously
4. **Smooth scrolling**: 4 cards at a time, already preloaded
5. **Smart caching**: Always maintains 12 ready cards
6. **Race condition protection**: Token-based request cancellation
7. **Memory efficient**: Proper cleanup of blobs and subscriptions

---

*This system ensures users experience smooth, uninterrupted scrolling with no loading delays.*

