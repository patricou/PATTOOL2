package com.pat.util;

import com.mongodb.DBRef;
import org.bson.Document;
import org.bson.types.Binary;
import org.bson.types.ObjectId;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Extracts a {@code members} document id from BSON shapes: {@link Document} DBRef,
 * {@link DBRef}, {@link ObjectId}, plain hex string, or a Java/Mongo {@code toString()} blob.
 */
public final class MemberReferenceIds {

    private static final Pattern DBREF_HEX_IN_QUOTES = Pattern.compile(
            "\"\\$id\"\\s*:\\s*\"([a-fA-F0-9]{24})\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OID_HEX_IN_QUOTES = Pattern.compile(
            "\"\\$oid\"\\s*:\\s*\"([a-fA-F0-9]{24})\"",
            Pattern.CASE_INSENSITIVE);

    private MemberReferenceIds() {
    }

    public static String extractMemberId(Object refVal) {
        if (refVal == null) {
            return null;
        }
        if (refVal instanceof Document doc) {
            Object refId = doc.get("$id");
            if (refId instanceof ObjectId oid) {
                return oid.toHexString();
            }
            if (refId instanceof Document oidDoc && oidDoc.get("$oid") != null) {
                String hex = oidDoc.get("$oid").toString().trim();
                return hex.isEmpty() ? null : hex;
            }
            if (refId instanceof Binary bin) {
                byte[] data = bin.getData();
                if (data != null && data.length == 12) {
                    return new ObjectId(data).toHexString();
                }
            }
            if (refId != null) {
                String nested = extractMemberIdFromScalarString(refId.toString());
                if (nested != null) {
                    return nested;
                }
                String s = refId.toString().trim();
                return s.isEmpty() ? null : s;
            }
            Object embeddedId = doc.get("id");
            if (embeddedId instanceof ObjectId oid) {
                return oid.toHexString();
            }
            if (embeddedId != null) {
                String nested = extractMemberIdFromScalarString(embeddedId.toString());
                if (nested != null) {
                    return nested;
                }
                String s = embeddedId.toString().trim();
                return s.isEmpty() ? null : s;
            }
            Object legacy = doc.get("_id");
            if (legacy instanceof ObjectId oid2) {
                return oid2.toHexString();
            }
            if (legacy != null) {
                String nested = extractMemberIdFromScalarString(legacy.toString());
                if (nested != null) {
                    return nested;
                }
                String s2 = legacy.toString().trim();
                return s2.isEmpty() ? null : s2;
            }
            return null;
        }
        if (refVal instanceof ObjectId oid) {
            return oid.toHexString();
        }
        if (refVal instanceof DBRef dbRef) {
            Object idObj = dbRef.getId();
            if (idObj instanceof ObjectId roid) {
                return roid.toHexString();
            }
            if (idObj != null) {
                String nested = extractMemberIdFromScalarString(idObj.toString());
                if (nested != null) {
                    return nested;
                }
                String s = idObj.toString().trim();
                return s.isEmpty() ? null : s;
            }
            return null;
        }
        if (refVal instanceof String str) {
            return extractMemberIdFromScalarString(str);
        }
        return extractMemberIdFromScalarString(refVal.toString());
    }

    /**
     * Normalizes a member id from plain 24-char hex or from a DBRef / extended-JSON string
     * (e.g. {@code { "$ref" : "members", "$id" : "..." }} mistakenly used as {@code Member#id}).
     */
    public static String extractMemberIdFromScalarString(String raw) {
        if (raw == null) {
            return null;
        }
        String t = raw.trim();
        if (t.isEmpty()) {
            return null;
        }
        if (ObjectId.isValid(t) && t.length() == 24) {
            return t.toLowerCase();
        }
        Matcher m = DBREF_HEX_IN_QUOTES.matcher(t);
        if (m.find()) {
            String hex = m.group(1).toLowerCase();
            if (ObjectId.isValid(hex)) {
                return hex;
            }
        }
        m = OID_HEX_IN_QUOTES.matcher(t);
        if (m.find()) {
            String hex = m.group(1).toLowerCase();
            if (ObjectId.isValid(hex)) {
                return hex;
            }
        }
        return null;
    }
}
