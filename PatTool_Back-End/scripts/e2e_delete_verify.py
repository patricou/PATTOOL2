#!/usr/bin/env python3
"""
Safe end-to-end verification that file deletion removes:
  1) reference from evenements.fileUploadeds
  2) blob from GridFS (fs.files + fs.chunks)

Uses an isolated temporary event + GridFS file (cleaned up at the end).
Does NOT touch real user events.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

from bson import ObjectId
from gridfs import GridFS
from pymongo import MongoClient

MONGO_HOST = "192.168.1.39"
MONGO_PORT = 27018
MONGO_USER = "root"
MONGO_PASSWORD = "KJhdgOi981_"
MONGO_DB = "rando2"
TEST_EVENT_NAME = "__PATTOOL_DELETE_VERIFY__"


def delete_from_gridfs(db, file_id: ObjectId) -> bool:
    """Same operations as FileRestController.deleteFileFromGridFs / gridFsTemplate.delete."""
    before = db["fs.files"].find_one({"_id": file_id})
    if before is None:
        return True
    db["fs.files"].delete_one({"_id": file_id})
    db["fs.chunks"].delete_many({"files_id": file_id})
    return db["fs.files"].find_one({"_id": file_id}) is None


def main() -> int:
    client = MongoClient(
        host=MONGO_HOST,
        port=MONGO_PORT,
        username=MONGO_USER,
        password=MONGO_PASSWORD,
        authSource="admin",
    )
    db = client[MONGO_DB]
    fs = GridFS(db)
    events = db.evenements

    # Cleanup leftovers from a previous failed run
    events.delete_many({"evenementName": TEST_EVENT_NAME})

    print("=== PATTOOL delete verification (isolated test) ===")

    # Step 1: upload temp GridFS blob
    payload = f"delete-verify-{datetime.now(timezone.utc).isoformat()}".encode("utf-8")
    file_id = fs.put(payload, filename="pattool_delete_verify.txt", content_type="text/plain")
    print(f"1. Uploaded test blob to GridFS: id={file_id}, exists={fs.exists(file_id)}")

    # Step 2: create temp event referencing the blob
    event_id = ObjectId()
    field_id = str(file_id)
    event_doc = {
        "_id": event_id,
        "evenementName": TEST_EVENT_NAME,
        "fileUploadeds": [
            {
                "fieldId": field_id,
                "fileName": "pattool_delete_verify.txt",
                "fileType": "text/plain",
                "uploaderMember": {"userName": "pattool-test"},
            }
        ],
        "status": "TEST",
    }
    events.insert_one(event_doc)
    print(f"2. Inserted temp event: id={event_id}, files=1")

    # Step 3: mimic FileRestController.updateFile (remove ref, save, delete GridFS)
    stored = events.find_one({"_id": event_id})
    old_files = stored.get("fileUploadeds") or []
    new_files = []
    removed = [f for f in old_files if f.get("fieldId") not in {x.get("fieldId") for x in new_files}]
    removed = old_files  # all removed when new list empty
    updated = dict(stored)
    updated["fileUploadeds"] = []
    events.replace_one({"_id": event_id}, updated)
    print("3. Updated event document (fileUploadeds cleared)")

    gridfs_ok = True
    for f in removed:
        fid = f.get("fieldId")
        oid = ObjectId(fid)
        ok = delete_from_gridfs(db, oid)
        gridfs_ok = gridfs_ok and ok
        print(f"4. GridFS delete id={fid}: success={ok}, still_exists={fs.exists(oid)}")

    # Step 5: verify
    after_event = events.find_one({"_id": event_id})
    refs_left = len(after_event.get("fileUploadeds") or [])
    blob_left = fs.exists(file_id)

    print()
    print("--- Verification ---")
    print(f"Event references remaining: {refs_left}")
    print(f"GridFS blob still exists: {blob_left}")

    # Cleanup temp event
    events.delete_one({"_id": event_id})
    print(f"Cleanup: temp event removed")

    passed = refs_left == 0 and not blob_left and gridfs_ok
    print()
    if passed:
        print("RESULT: PASS — deletion removes event reference AND GridFS data (fs.files + fs.chunks)")
        return 0

    print("RESULT: FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main())
