#!/usr/bin/env python3
"""Verify GridFS file references vs evenements.fileUploadeds in MongoDB."""

from __future__ import annotations

import sys
from collections import Counter

from bson import ObjectId
from pymongo import MongoClient

MONGO_HOST = "192.168.1.39"
MONGO_PORT = 27018
MONGO_USER = "root"
MONGO_PASSWORD = "KJhdgOi981_"
MONGO_DB = "rando2"


def main() -> int:
    client = MongoClient(
        host=MONGO_HOST,
        port=MONGO_PORT,
        username=MONGO_USER,
        password=MONGO_PASSWORD,
        authSource="admin",
    )
    db = client[MONGO_DB]

    events = list(db.evenements.find({}, {"evenementName": 1, "fileUploadeds": 1, "thumbnail": 1}))
    fs_files = db["fs.files"]
    fs_chunks = db["fs.chunks"]

    referenced_ids: set[str] = set()
    ref_counter: Counter[str] = Counter()

    for ev in events:
        for fu in ev.get("fileUploadeds") or []:
            fid = fu.get("fieldId")
            if fid:
                referenced_ids.add(fid)
                ref_counter[fid] += 1
        thumb = ev.get("thumbnail") or {}
        tfid = thumb.get("fieldId")
        if tfid:
            referenced_ids.add(tfid)
            ref_counter[tfid] += 1

    missing_in_gridfs: list[tuple[str, str, str]] = []
    for fid in sorted(referenced_ids):
        try:
            oid = ObjectId(fid)
        except Exception:
            missing_in_gridfs.append((fid, "?", "invalid ObjectId"))
            continue
        doc = fs_files.find_one({"_id": oid})
        if doc is None:
            # find events referencing this id
            names = []
            for ev in events:
                for fu in ev.get("fileUploadeds") or []:
                    if fu.get("fieldId") == fid:
                        names.append(ev.get("evenementName", ev.get("_id")))
            missing_in_gridfs.append((fid, ", ".join(names[:3]), "missing in fs.files"))

    gridfs_ids: set[str] = set()
    for doc in fs_files.find({}, {"_id": 1}):
        gridfs_ids.add(str(doc["_id"]))

    orphaned = sorted(gridfs_ids - referenced_ids)

    print("=== MongoDB GridFS integrity check ===")
    print(f"Events scanned: {len(events)}")
    print(f"Referenced file ids: {len(referenced_ids)}")
    print(f"GridFS files (fs.files): {len(gridfs_ids)}")
    print(f"GridFS chunks (fs.chunks): {fs_chunks.count_documents({})}")
    print()

    if missing_in_gridfs:
        print(f"REFERENCES WITHOUT GridFS FILE ({len(missing_in_gridfs)}):")
        for fid, ev_name, reason in missing_in_gridfs[:20]:
            print(f"  - {fid} | event(s): {ev_name} | {reason}")
        if len(missing_in_gridfs) > 20:
            print(f"  ... and {len(missing_in_gridfs) - 20} more")
    else:
        print("OK: every referenced fileUploadeds/thumbnail id exists in fs.files")

    print()
    print(f"ORPHAN GridFS files (in fs.files but not referenced by any event): {len(orphaned)}")
    if orphaned:
        for fid in orphaned[:15]:
            doc = fs_files.find_one({"_id": ObjectId(fid)}, {"filename": 1, "length": 1, "uploadDate": 1})
            name = doc.get("filename") if doc else "?"
            size = doc.get("length") if doc else "?"
            print(f"  - {fid} | {name} | {size} bytes")
        if len(orphaned) > 15:
            print(f"  ... and {len(orphaned) - 15} more")

    # Sample event with most files (likely Elado from UI)
    rich = max(events, key=lambda e: len(e.get("fileUploadeds") or []), default=None)
    if rich:
        name = rich.get("evenementName", rich.get("_id"))
        files = rich.get("fileUploadeds") or []
        print()
        print(f"Sample event with most files: {name!r} ({len(files)} files)")
        for fu in files[:5]:
            fid = fu.get("fieldId")
            fname = fu.get("fileName")
            in_fs = fs_files.find_one({"_id": ObjectId(fid)}) is not None if fid else False
            print(f"  - {fname} | id={fid} | in GridFS={in_fs}")

    return 1 if missing_in_gridfs else 0


if __name__ == "__main__":
    sys.exit(main())
