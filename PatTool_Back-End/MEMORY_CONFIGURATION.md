# Memory Configuration Guide

## Overview

This document provides guidance on configuring JVM memory settings to prevent `OutOfMemoryError` in the PatTool backend application.

## Current Memory Protection Features

1. **OutOfMemoryError Handler**: Automatically catches and handles OOM errors gracefully
2. **Memory Monitoring Service**: Monitors memory usage and logs warnings
3. **Memory Check Filter**: Rejects requests when memory usage is critical (>90%)
4. **Early Detection**: Prevents OOM by rejecting requests before memory is exhausted

## JVM Memory Configuration

### Recommended Settings

For a production server with moderate load:

```bash
# Minimum heap size: 2GB
# Maximum heap size: 4GB
# Use G1GC garbage collector (recommended for Java 11+)
java -Xms2g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -jar pattool-0.0.1-SNAPSHOT.jar
```

### For High-Load Servers

```bash
# Minimum heap size: 4GB
# Maximum heap size: 8GB
# Use G1GC with optimized settings
java -Xms4g -Xmx8g \
     -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -XX:G1HeapRegionSize=16m \
     -XX:InitiatingHeapOccupancyPercent=45 \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/var/log/pattool/heapdump.hprof \
     -jar pattool-0.0.1-SNAPSHOT.jar
```

### For Development/Low-Load Servers

```bash
# Minimum heap size: 512MB
# Maximum heap size: 2GB
java -Xms512m -Xmx2g -XX:+UseG1GC -jar pattool-0.0.1-SNAPSHOT.jar
```

## Application Properties Configuration

The following properties in `application.properties` control memory monitoring:

```properties
# Memory monitoring settings
# Warning threshold: Log warning when memory usage exceeds this percentage (default: 85%)
app.memory.warning-threshold=85
# Critical threshold: Reject requests when memory usage exceeds this percentage (default: 90%)
app.memory.critical-threshold=90
```

### Adjusting Thresholds

- **Lower thresholds (e.g., 80% warning, 85% critical)**: More conservative, rejects requests earlier
- **Higher thresholds (e.g., 90% warning, 95% critical)**: More aggressive, allows higher memory usage

**Recommendation**: Keep critical threshold at 90% or lower to prevent OOM errors.

## Memory Usage Patterns

### High Memory Usage Scenarios

1. **Large File Uploads**: Files up to 250MB are loaded into memory during processing
2. **Event Streaming**: Streaming all events can accumulate memory if there are many events
3. **Image Compression**: Multiple concurrent image compressions can use significant memory
4. **MongoDB Queries**: Large result sets can consume memory

### Optimization Tips

1. **File Uploads**: Consider streaming file processing instead of loading entire files into memory
2. **Event Streaming**: The current implementation uses MongoDB cursors which is memory-efficient
3. **Image Compression**: The `app.image.compression.max-concurrency` setting limits concurrent operations
4. **Database Queries**: Use pagination or cursors for large result sets

## Monitoring Memory Usage

### Application Logs

The application logs memory warnings when usage exceeds the warning threshold:

```
WARNING: High memory usage detected: 87.5% (3500 MB / 4000 MB). 
Consider increasing heap size or investigating memory leaks.
```

### Critical Alerts

When memory usage is critical, requests are rejected:

```
CRITICAL: Memory usage at 92.3% (3692 MB / 4000 MB). 
Server may reject requests to prevent OutOfMemoryError.
```

### Heap Dumps

If you configure `-XX:+HeapDumpOnOutOfMemoryError`, a heap dump will be created when OOM occurs. 
Analyze the heap dump with tools like:
- Eclipse MAT (Memory Analyzer Tool)
- VisualVM
- jhat (Java Heap Analysis Tool)

## Troubleshooting

### OutOfMemoryError Still Occurs

1. **Increase heap size**: Increase `-Xmx` value
2. **Lower critical threshold**: Reduce `app.memory.critical-threshold` to reject requests earlier
3. **Investigate memory leaks**: Use heap dumps and profiling tools
4. **Optimize code**: Review file upload and data processing code

### Too Many Requests Rejected

1. **Increase heap size**: More memory = fewer rejections
2. **Raise critical threshold**: Only if you're confident about memory usage patterns
3. **Optimize memory usage**: Reduce memory footprint of operations

### Memory Warnings Too Frequent

1. **Increase warning threshold**: Only if memory usage is stable
2. **Investigate memory leaks**: Frequent warnings may indicate a leak
3. **Optimize operations**: Reduce memory usage of heavy operations

## System Requirements

### Minimum System Memory

- **Development**: 4GB RAM (2GB for JVM + 2GB for OS)
- **Production (Low Load)**: 8GB RAM (4GB for JVM + 4GB for OS)
- **Production (High Load)**: 16GB+ RAM (8GB+ for JVM + 8GB+ for OS)

### Disk Space

Ensure sufficient disk space for:
- Heap dumps (if enabled): ~2-4x heap size
- Application logs
- Temporary files during file uploads

## Best Practices

1. **Set -Xms equal to -Xmx**: Prevents heap resizing overhead
2. **Use G1GC**: Best for applications with varying heap sizes
3. **Monitor regularly**: Check logs for memory warnings
4. **Test with production-like data**: Ensure heap size is adequate
5. **Enable heap dumps**: Helps diagnose OOM issues
6. **Review memory monitoring logs**: Identify patterns and optimize

## Related Files

- `GlobalExceptionHandler.java`: Handles OutOfMemoryError
- `MemoryMonitoringService.java`: Monitors memory usage
- `MemoryCheckFilter.java`: Rejects requests when memory is critical
- `application.properties`: Configuration for memory thresholds
