# IntelliJ IDEA Memory Configuration Setup

## Quick Setup

### Option 1: Use Pre-configured Run Configuration (Easiest)

A run configuration file has already been created at `.idea/runConfigurations/PatToolApplication.xml`.

1. **Reload IntelliJ** (if the configuration doesn't appear automatically):
   - Go to **File** → **Invalidate Caches / Restart...**
   - Select **Invalidate and Restart**

2. **Verify the configuration**:
   - Go to **Run** → **Edit Configurations...**
   - You should see **"PatToolApplication"** in the list
   - Select it and check that the **VM options** field contains:
     ```
     -Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./logs/heapdump.hprof -Dfile.encoding=UTF-8
     ```

3. **Run the application**:
   - Select **"PatToolApplication"** from the run configuration dropdown (top-right)
   - Click the green **Run** button (or press `Shift+F10`)

### Option 2: Manual Setup

If the pre-configured file doesn't work, create it manually:

1. **Open Run Configuration Dialog**:
   - Press `Alt+Shift+F10` then `0`, OR
   - Go to **Run** → **Edit Configurations...**

2. **Create New Configuration**:
   - Click the **"+"** button (top-left)
   - Select **Spring Boot**

3. **Configure Settings**:
   - **Name**: `PatToolApplication`
   - **Main class**: Click the folder icon and select `com.pat.PatToolApplication`
   - **Module**: Select `pattool` from the dropdown
   - **VM options**: Paste the following:
     ```
     -Xms512m -Xmx2048m -XX:MaxMetaspaceSize=512m -XX:MaxDirectMemorySize=512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./logs/heapdump.hprof -Dfile.encoding=UTF-8
     ```

4. **Apply and Run**:
   - Click **Apply** then **OK**
   - Select the configuration from the dropdown
   - Click **Run** (green play button) or press `Shift+F10`

## Screenshot Locations

The VM options field is located in:
- **Configuration** tab
- Below the "Main class" field
- It's a text area where you can paste multiple JVM arguments

## Verify Configuration

After setup, you can verify the memory settings are applied:

1. **Run the application**
2. **Check the console output** - you should see JVM arguments in the startup logs
3. **Monitor memory** - Use IntelliJ's built-in memory indicator (bottom-right status bar)

## Troubleshooting

### Configuration Not Appearing
- **Invalidate caches**: File → Invalidate Caches / Restart
- **Check file location**: Ensure `.idea/runConfigurations/PatToolApplication.xml` exists
- **Manual creation**: Use Option 2 above

### Still Getting Memory Errors
1. **Check VM options**: Ensure all options are in the "VM options" field (not "Program arguments")
2. **Verify module**: Make sure the correct module (`pattool`) is selected
3. **Check IntelliJ memory**: IntelliJ itself might need more memory:
   - Help → Edit Custom VM Options
   - Add: `-Xmx2048m` (or higher if you have 16GB+ RAM)
   - Restart IntelliJ

### Module Not Found
- **Import project**: File → New → Project from Existing Sources
- **Maven import**: Right-click `pom.xml` → Maven → Reload Project
- **Sync**: File → Sync Project with Gradle Files (if applicable)

## Memory Settings Explained

- **`-Xms512m`**: Initial heap size (512MB)
- **`-Xmx2048m`**: Maximum heap size (2GB)
- **`-XX:MaxMetaspaceSize=512m`**: Maximum metaspace for class metadata
- **`-XX:MaxDirectMemorySize=512m`**: Maximum direct memory (NIO buffers)
- **`-XX:+UseG1GC`**: Use G1 garbage collector
- **`-XX:MaxGCPauseMillis=200`**: Target GC pause time
- **`-XX:+HeapDumpOnOutOfMemoryError`**: Create heap dump on OOM
- **`-XX:HeapDumpPath=./logs/heapdump.hprof`**: Location for heap dumps

## Additional IntelliJ Settings

### Increase IntelliJ's Own Memory (Optional)
If IntelliJ itself is slow:

1. **Help** → **Edit Custom VM Options**
2. Add or modify:
   ```
   -Xms512m
   -Xmx2048m
   ```
3. **Restart IntelliJ**

### Enable Memory Indicator
1. **View** → **Appearance** → **Status Bar Widgets** → **Memory Indicator**
2. Shows current memory usage in the bottom-right corner

