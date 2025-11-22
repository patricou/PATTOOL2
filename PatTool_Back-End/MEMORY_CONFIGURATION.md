# Memory Configuration Guide

## Problem
The application was experiencing out-of-memory errors with the following symptoms:
- `Java HotSpot(TM) 64-Bit Server VM warning: INFO: os::commit_memory(...) failed; error='The paging file is too small'`
- `Native memory allocation (mmap) failed to map 2097152 bytes for G1 virtual space`
- Application crashes during file upload operations

## Root Cause
The application processes large files (up to 250MB per file, 700MB per request) and loads entire files into memory for image compression. The default JVM memory settings were insufficient for these operations.

## Solution

### JVM Memory Settings
The following memory configuration has been applied:

- **Initial Heap Size (`-Xms`)**: 512MB
- **Maximum Heap Size (`-Xmx`)**: 2048MB (2GB)
- **Max Metaspace Size**: 512MB (for class metadata)
- **Max Direct Memory Size**: 512MB (for NIO buffers and native memory)
- **Garbage Collector**: G1GC (G1 Garbage Collector)
- **GC Pause Target**: 200ms

### How to Run

#### Option 1: Using the Batch Script (Recommended)
```batch
# For production JAR
run.bat

# For development mode
run-dev.bat
```

#### Option 2: Manual Command Line
```batch
# For production JAR
java -Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -jar target\pattool-0.0.1-SNAPSHOT.jar

# For development mode
set MAVEN_OPTS=-Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200
mvn spring-boot:run
```

#### Option 3: IntelliJ IDEA Run Configuration

**Method 1: Using the Pre-configured Run Configuration (Recommended)**
A run configuration file has been created at `.idea/runConfigurations/PatToolApplication.xml`. 
IntelliJ should automatically detect it. If not:
1. Go to Run → Edit Configurations
2. Click the "+" button → Spring Boot
3. Name it "PatToolApplication"
4. Main class: `com.pat.PatToolApplication`
5. In "VM options", add:
```
-Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./logs/heapdump.hprof -Dfile.encoding=UTF-8
```

**Method 2: Manual Configuration**
1. Go to **Run** → **Edit Configurations...** (or press `Alt+Shift+F10` then `0`)
2. Click the **"+"** button in the top-left corner
3. Select **Spring Boot**
4. Configure:
   - **Name**: `PatToolApplication`
   - **Main class**: `com.pat.PatToolApplication`
   - **Module**: `pattool`
5. In the **"VM options"** field, paste:
```
-Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./logs/heapdump.hprof -Dfile.encoding=UTF-8
```
6. Click **Apply** and **OK**
7. Now you can run the application using the green play button or `Shift+F10`

**Visual Guide:**
- The VM options field is located in the "Configuration" tab
- It's usually below the "Main class" field
- Make sure to select the correct module (`pattool`) from the dropdown

### Memory Settings Explained

- **`-Xms512m`**: Initial heap size. Starting with 512MB prevents frequent heap resizing.
- **`-Xmx2048m`**: Maximum heap size. 2GB should be sufficient for most operations.
- **`-XX:MaxMetaspaceSize=512m`**: Limits the metaspace (class metadata) to prevent native memory issues.
- **`-XX:MaxDirectMemorySize=512m`**: Limits direct memory allocation, which is separate from heap memory.
- **`-XX:+UseG1GC`**: Uses the G1 garbage collector, which is better for large heap sizes.
- **`-XX:MaxGCPauseMillis=200`**: Targets GC pauses under 200ms for better responsiveness.

### Windows Paging File (CRITICAL - Required!)

**If you're getting "paging file is too small" errors, you MUST increase the Windows paging file.**

This is a **Windows system requirement**, not just a Java configuration issue.

**Quick Check:**
```batch
# Run this script to check your current paging file settings
check-paging-file.bat
```

**To Fix:**
1. Press `Windows + Pause/Break` (or Right-click **This PC** → **Properties**)
2. Click **Advanced system settings**
3. **Performance** section → **Settings...**
4. **Advanced** tab → **Virtual Memory** → **Change...**
5. **Uncheck** "Automatically manage paging file size"
6. Select **C:** drive
7. Select **Custom size**:
   - **Initial size**: `4096` (4GB)
   - **Maximum size**: `8192` (8GB) or `12288` (12GB)
8. Click **Set** → **OK**
9. **RESTART YOUR COMPUTER** (required!)

**See `WINDOWS_PAGING_FILE_FIX.md` for detailed instructions and troubleshooting.**

**Temporary Workaround:**
If you can't increase the paging file right now, use the "PatToolApplication (Low Memory)" run configuration in IntelliJ, which uses reduced memory settings.

### Monitoring Memory Usage
The application is configured to create heap dumps on out-of-memory errors:
- Location: `./logs/heapdump.hprof`
- Use tools like Eclipse MAT or VisualVM to analyze heap dumps

### Adjusting Memory Settings
If you need to adjust memory settings based on your system:

- **For systems with 4GB RAM**: Use `-Xmx1024m` (1GB)
- **For systems with 8GB+ RAM**: Current settings (2GB) should work well
- **For systems with 16GB+ RAM**: You can increase to `-Xmx4096m` (4GB) if needed

### Troubleshooting
If memory issues persist:

1. Check heap dump files in `./logs/` directory
2. Monitor memory usage with JVisualVM or similar tools
3. Consider optimizing file processing to use streaming instead of loading entire files into memory
4. Review application logs for memory-related warnings
5. Check Windows Event Viewer for system-level memory issues

