# MongoDB Migration Guide

This guide will help you migrate data from MongoDB v4 (port 27017) to MongoDB 8.2 (port 27018).

## Prerequisites

1. **MongoDB Database Tools** must be installed at:
   - Path: `C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0`
   - The scripts are configured to use this path automatically
   - If your tools are in a different location, you can modify the `$MongoToolsPath` parameter in the PowerShell script or `MONGO_TOOLS_PATH` variable in the batch file

2. **MongoDB Shell** (optional, for verification):
   - Download from: https://www.mongodb.com/try/download/shell
   - Either `mongosh` (recommended) or `mongo` (legacy)

3. **Both MongoDB instances must be running**:
   - MongoDB v4 on `192.168.1.33:27017`
   - MongoDB 8.2 on `192.168.1.33:27018`

## Migration Steps

### Step 1: Backup Current Data

Before starting the migration, ensure you have a backup of your current data. The migration script will create a backup automatically, but it's recommended to have an additional backup.

### Step 2: Run the Migration Script

Open PowerShell in the `PatTool_Back-End` directory and run:

```powershell
.\migrate-mongodb.ps1
```

The script will:
1. Check for required tools (mongodump, mongorestore)
2. Create a backup directory
3. Dump all data from MongoDB v4 (port 27017)
4. Restore data to MongoDB 8.2 (port 27018)
5. Verify the migration

**Note**: The restore operation will **DROP** existing data in the target database. Make sure you have backups!

### Step 3: Verify the Migration

Run the verification script:

```powershell
.\verify-mongodb-migration.ps1
```

This will:
- Connect to MongoDB 8.2
- List all collections
- Show document counts for each collection

### Step 4: Update Application Configuration

The `application.properties` file has already been updated to use MongoDB 8.2:
- `spring.data.mongodb.port=27018`

### Step 5: Test the Application

1. Restart your Spring Boot application
2. Test all functionality to ensure everything works correctly
3. Verify that data is being read/written correctly

### Step 6: Monitor and Validate

After running the application for a while:
- Check application logs for any MongoDB-related errors
- Verify that all collections are accessible
- Test critical operations (create, read, update, delete)

## Manual Migration (Alternative)

If you prefer to run the commands manually:

### 1. Dump data from MongoDB v4:
```bash
mongodump --host 192.168.1.33 --port 27017 --db rando --out ./mongodb-backup
```

### 2. Restore data to MongoDB 8.2:
```bash
mongorestore --host 192.168.1.33 --port 27018 --db rando --drop ./mongodb-backup/rando
```

**Warning**: The `--drop` flag will delete existing data in the target database!

### 3. Verify manually:
```bash
mongosh mongodb://192.168.1.33:27018/rando
```

Then in the MongoDB shell:
```javascript
show collections
db.getCollectionNames().forEach(c => print(c + ': ' + db.getCollection(c).countDocuments()))
```

## Troubleshooting

### Issue: "mongodump not found"
**Solution**: 
- Verify MongoDB Database Tools are installed at `C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0`
- If installed elsewhere, update the `$MongoToolsPath` parameter in the PowerShell script or `MONGO_TOOLS_PATH` variable in the batch file

### Issue: "Connection refused"
**Solution**: 
- Verify both MongoDB instances are running
- Check firewall settings
- Verify network connectivity to 192.168.1.33

### Issue: "Authentication failed"
**Solution**: If your MongoDB instances require authentication, you may need to modify the migration script to include username/password:
```bash
mongodump --host 192.168.1.33 --port 27017 --db rando --username <user> --password <pass> --authenticationDatabase admin --out ./mongodb-backup
```

### Issue: "Version compatibility"
**Solution**: MongoDB 8.2 should be able to read data from MongoDB v4. If you encounter issues, check MongoDB compatibility documentation.

## Rollback Plan

If you need to rollback:
1. Stop the application
2. Update `application.properties` to use port 27017
3. Restart the application
4. MongoDB v4 data should still be intact (unless you stopped the instance)

## Post-Migration

Once you've verified everything works correctly:
1. Keep the backup files for at least 30 days
2. Monitor the application for any issues
3. After a successful period, you can consider stopping MongoDB v4

## Important Notes

- **GridFS files**: If you're using GridFS for file storage, make sure those are also migrated. The migration script should handle this automatically.
- **Indexes**: Indexes should be recreated automatically during restore, but verify important indexes are present.
- **Replication**: If you're using replication, ensure MongoDB 8.2 is properly configured.

## Support

If you encounter issues during migration:
1. Check MongoDB logs for both instances
2. Review application logs
3. Verify network connectivity
4. Ensure sufficient disk space for backups

