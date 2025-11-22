# Windows Paging File Fix - Critical for Memory Issues

## Problem
Even with proper JVM memory settings, you're getting:
```
error='The paging file is too small for this operation to complete'
Native memory allocation (mmap) failed to map 424673280 bytes for G1 virtual space
```

This is a **Windows system-level issue** - your paging file (virtual memory) is too small.

## Solution: Increase Windows Paging File

### Step-by-Step Instructions

1. **Open System Properties**:
   - Press `Windows + Pause/Break` key, OR
   - Right-click **This PC** → **Properties**, OR
   - Press `Windows + R`, type `sysdm.cpl`, press Enter

2. **Navigate to Virtual Memory Settings**:
   - Click **Advanced system settings** (left sidebar)
   - In the **Performance** section, click **Settings...**
   - Go to the **Advanced** tab
   - Under **Virtual memory**, click **Change...**

3. **Configure Paging File**:
   - **Uncheck** "Automatically manage paging file size for all drives"
   - Select your system drive (usually **C:**)
   - Select **Custom size**
   - Set:
     - **Initial size (MB)**: `4096` (4GB)
     - **Maximum size (MB)**: `8192` (8GB) or `12288` (12GB) if you have space
   - Click **Set**
   - Click **OK**

4. **Restart Your Computer**:
   - Windows will prompt you to restart
   - **You must restart** for changes to take effect

### Alternative: Quick Settings (Minimum)

If you're short on disk space, use these minimum settings:
- **Initial size**: `2048` (2GB)
- **Maximum size**: `4096` (4GB)

### Verify After Restart

1. Run your application again
2. The memory error should be resolved
3. If issues persist, increase the maximum size further

## Why This Happens

- **Paging file** = Virtual memory on disk that Windows uses when RAM is full
- **G1GC** needs to reserve virtual memory addresses (even if not all used immediately)
- **Windows default** paging file is often too small for Java applications
- **Java 21 + G1GC** requires more virtual memory space than older JVMs

## Alternative: Reduce Memory Settings (Temporary Workaround)

If you **cannot** increase the paging file right now, you can temporarily reduce JVM memory:

### For IntelliJ:
Update VM options to:
```
-Xms256m -Xmx1024m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=256m -XX:+UseG1GC -XX:MaxGCPauseMillis=200
```

### For Command Line:
```batch
java -Xms256m -Xmx1024m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=256m -XX:+UseG1GC -jar target\pattool-0.0.1-SNAPSHOT.jar
```

**Note**: This is a temporary workaround. You should still increase the paging file for optimal performance.

## Check Current Paging File Size

To see your current paging file settings:

1. Open **Task Manager** (`Ctrl + Shift + Esc`)
2. Go to **Performance** tab
3. Click **Memory** (left sidebar)
4. Look at the bottom for "Committed" value
5. Or use Command Prompt:
   ```cmd
   wmic pagefileset get name,InitialSize,MaximumSize
   ```

## Recommended Paging File Sizes

Based on your RAM:
- **4GB RAM**: 4096MB initial, 8192MB max
- **8GB RAM**: 4096MB initial, 8192MB max
- **16GB+ RAM**: 4096MB initial, 12288MB max

## Troubleshooting

### "Access Denied" Error
- Run the System Properties dialog as Administrator
- Right-click **This PC** → **Properties** → Run as Administrator

### Changes Don't Take Effect
- **You must restart** your computer for paging file changes to apply
- Logging out and back in is NOT sufficient

### Still Getting Errors After Increase
1. Check that you restarted (required!)
2. Verify the paging file was actually set (use `wmic` command above)
3. Try increasing maximum size further (up to 16GB if you have space)
4. Consider using a different drive for the paging file if C: is full

### Disk Space Concerns
- The paging file only uses space when needed
- It's dynamically sized between initial and maximum
- You can set it on a different drive if C: is full

## Summary

**The fix requires:**
1. ✅ Increasing Windows paging file to at least 4GB initial, 8GB max
2. ✅ Restarting your computer
3. ✅ Then running your application with the JVM memory settings we configured

**This is a Windows system requirement, not a Java application issue.**

