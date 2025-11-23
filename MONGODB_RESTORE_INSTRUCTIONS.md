# MongoDB Restore Instructions

## Backup Location
`S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2`

## Database to Restore
Database name: `rando2`

Collections included:
- categorylink
- Copy_of_urllink
- delete_me
- evenements
- fs.chunks
- fs.files
- mandatory_DB
- members
- toto
- urllink

---

## Method 1: Using PowerShell Script (Recommended)

1. Run the provided PowerShell script:
   ```powershell
   .\restore_mongodb.ps1
   ```

2. Make sure MongoDB Database Tools are installed. If not:
   - Download from: https://www.mongodb.com/try/download/database-tools
   - Add to PATH or update the script with the full path

---

## Method 2: Using Command Line Directly

### Step 1: Find mongorestore
MongoDB Database Tools are usually installed at:
- `C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe`
- Or check your MongoDB installation directory

### Step 2: Update the connection string
**⚠️ IMPORTANT:** Before running, you need to replace `xxxxx` in the connection string with your actual MongoDB password!

### Step 3: Run mongorestore

**If mongorestore is in your PATH:**
```powershell
mongorestore --uri "mongodb+srv://patricou:YOUR_PASSWORD@rando.ieagq.mongodb.net/" --db "rando2" --drop "S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2"
```

**If using full path:**
```powershell
"C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe" --uri "mongodb+srv://patricou:YOUR_PASSWORD@rando.ieagq.mongodb.net/" --db "rando2" --drop "S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2"
```

**⚠️ IMPORTANT:** Replace `YOUR_PASSWORD` with your actual MongoDB password!

### Parameters explained:
- `--uri`: MongoDB Atlas connection string (`mongodb+srv://patricou:YOUR_PASSWORD@rando.ieagq.mongodb.net/`)
- `--db`: Target database name (will create/overwrite `rando2`)
- `--drop`: Drops existing collections before restoring (remove if you want to merge)
- Last argument: Path to the backup directory

**⚠️ Remember to replace `YOUR_PASSWORD` with your actual password!**

---

## Method 3: Using MongoDB Compass

**Note:** Compass shell (JavaScript shell) cannot directly run `mongorestore`. However, you can:

### Option A: Use Compass Import Feature
1. Open MongoDB Compass
2. Connect to your MongoDB instance
3. For each collection:
   - Click on the database → Create Collection (if needed)
   - Click on the collection → Click "Import Data"
   - Import the `.bson` files individually

### Option B: Use Compass to Run mongorestore via Command
1. Open MongoDB Compass
2. Open Terminal/Command Prompt separately
3. Run the mongorestore command from Method 2

---

## Method 4: Restore to Different Database Name

If you want to restore to a different database (e.g., `rando2_restored`):

```powershell
mongorestore --uri "mongodb+srv://patricou:YOUR_PASSWORD@rando.ieagq.mongodb.net/" --db "rando2_restored" "S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2"
```

**⚠️ Remember to replace `YOUR_PASSWORD` with your actual password!**

---

## Troubleshooting

### Error: mongorestore not found
- Install MongoDB Database Tools
- Or use the full path to mongorestore.exe

### Error: Connection refused
- Check if MongoDB is running
- Verify connection string (host, port, authentication if needed)

### Error: Authentication failed
- Add credentials to connection string: `mongodb://username:password@localhost:27017`

### Want to merge instead of replace?
- Remove the `--drop` flag from the command

---

## Verify Restore

After restoring, you can verify in MongoDB Compass:
1. Connect to your MongoDB instance
2. Check that the `rando2` database exists
3. Verify all collections are present with data

Or use Compass shell (JavaScript):
```javascript
use rando2
db.getCollectionNames()
db.evenements.countDocuments()  // Check a specific collection
```

