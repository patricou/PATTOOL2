# JVM Memory Leak Fix - Free Memory Decreasing Issue

## Problem Identified

The JVM free memory was decreasing without reason due to several memory leak issues in the `EvenementRestController`:

### 1. **CachedThreadPool Memory Leak** (Critical)
- **Issue**: The controller used `Executors.newCachedThreadPool()` which creates threads on demand and keeps them alive for 60 seconds
- **Problem**: 
  - Threads accumulate over time if created faster than they're cleaned up
  - Each thread consumes memory (stack space ~1MB per thread, thread-local variables)
  - The executor service was never shut down, causing threads to accumulate indefinitely
  - With many concurrent streaming requests, this can quickly exhaust memory

### 2. **Null-Dated Events Accumulation** (Moderate)
- **Issue**: All events with null dates were accumulated in a list before being sent
- **Problem**: 
  - If there are many events with null dates, this list can grow unbounded
  - Each event object consumes memory
  - No limit on the accumulation size

### 3. **No Resource Cleanup** (Critical)
- **Issue**: No lifecycle management for the executor service
- **Problem**: 
  - When the application shuts down, threads are not properly cleaned up
  - Resources remain allocated even after application stops

## Solutions Implemented

### 1. Replaced CachedThreadPool with Bounded ThreadPoolExecutor

**Before:**
```java
private final ExecutorService executorService = Executors.newCachedThreadPool();
```

**After:**
```java
private final ExecutorService executorService = new ThreadPoolExecutor(
    5,  // Core pool size
    50, // Maximum pool size (bounded to prevent memory issues)
    30L, TimeUnit.SECONDS, // Keep-alive time for idle threads
    new LinkedBlockingQueue<>(1000), // Bounded queue to prevent unbounded memory growth
    new ThreadPoolExecutor.CallerRunsPolicy() // Reject policy: run in caller thread if queue is full
);
```

**Benefits:**
- **Bounded thread creation**: Maximum of 50 threads prevents unbounded growth
- **Bounded queue**: Maximum 1000 queued tasks prevents memory buildup
- **Proper rejection policy**: If queue is full, tasks run in caller thread instead of failing silently
- **Configurable**: Easy to adjust pool size based on server capacity

### 2. Limited Null-Dated Events Accumulation

**Before:**
```java
List<Evenement> nullDateEvents = new java.util.ArrayList<>();
// ... accumulates all null-dated events
```

**After:**
```java
List<Evenement> nullDateEvents = new java.util.ArrayList<>(1000);
// ... with limit check
if (nullDateEvents.size() < 1000) {
    nullDateEvents.add(event);
} else {
    // Send immediately to prevent memory buildup
    // ... send event immediately
}
```

**Benefits:**
- **Memory limit**: Maximum 1000 null-dated events in memory
- **Immediate sending**: If limit reached, events are sent immediately instead of accumulating
- **Prevents unbounded growth**: Memory usage is predictable

### 3. Added Proper Resource Cleanup

**Added:**
```java
@PreDestroy
public void cleanup() {
    log.info("Shutting down executor service for event streaming...");
    executorService.shutdown();
    try {
        // Wait up to 30 seconds for tasks to complete
        if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
            log.warn("Executor service did not terminate gracefully, forcing shutdown...");
            executorService.shutdownNow();
            // Wait again for forced shutdown
            if (!executorService.awaitTermination(10, TimeUnit.SECONDS)) {
                log.error("Executor service did not terminate after forced shutdown");
            }
        } else {
            log.info("Executor service terminated gracefully");
        }
    } catch (InterruptedException e) {
        log.error("Interrupted while waiting for executor service to terminate", e);
        executorService.shutdownNow();
        Thread.currentThread().interrupt();
    }
}
```

**Benefits:**
- **Graceful shutdown**: Waits for running tasks to complete
- **Forced shutdown**: If tasks don't complete, forces shutdown after timeout
- **Proper cleanup**: All threads are properly terminated when application stops
- **Prevents resource leaks**: No threads left running after application shutdown

## Expected Results

After these fixes:

1. **Memory Usage Stabilization**: 
   - Thread count is bounded (max 50 threads)
   - Memory usage should stabilize instead of continuously decreasing
   - No more unbounded thread accumulation

2. **Predictable Memory Consumption**:
   - Maximum memory for null-dated events: ~1000 events × average event size
   - Maximum queued tasks: 1000 tasks
   - Total thread memory: ~50 threads × ~1MB = ~50MB (bounded)

3. **Proper Resource Management**:
   - Threads are cleaned up on application shutdown
   - No resource leaks during application lifecycle
   - Better memory management overall

## Monitoring Recommendations

1. **Monitor Thread Count**: 
   - Use JVM monitoring tools (jconsole, VisualVM) to verify thread count stays within bounds
   - Should see thread count stabilize around 5-50 threads instead of continuously growing

2. **Monitor Memory Usage**:
   - Watch heap memory usage - should stabilize instead of continuously decreasing
   - Monitor for OutOfMemoryError - should be less frequent

3. **Check Application Logs**:
   - Look for "Shutting down executor service" message on application shutdown
   - Verify "Executor service terminated gracefully" appears

## Configuration Tuning

If you experience issues with the new thread pool configuration, you can adjust:

- **Core pool size** (currently 5): Increase if you have many concurrent streaming requests
- **Maximum pool size** (currently 50): Increase if you have high concurrency, but be mindful of memory
- **Queue size** (currently 1000): Increase if you have burst traffic, but monitor memory usage
- **Keep-alive time** (currently 30 seconds): Adjust based on your traffic patterns

## Related Files Modified

- `PatTool_Back-End/src/main/java/com/pat/controller/EvenementRestController.java`

## Testing Recommendations

1. **Load Testing**: 
   - Test with multiple concurrent streaming requests
   - Verify thread count doesn't exceed 50
   - Monitor memory usage over time

2. **Long-Running Test**:
   - Run application for extended period (hours/days)
   - Monitor memory usage - should remain stable
   - Check for memory leaks using profiling tools

3. **Shutdown Test**:
   - Stop application and verify executor service shuts down properly
   - Check logs for cleanup messages
   - Verify no threads remain after shutdown

## Additional Notes

- The fixes maintain backward compatibility - no API changes
- Streaming functionality remains the same from client perspective
- Performance should be similar or better due to bounded resource usage
- Memory usage is now predictable and bounded

