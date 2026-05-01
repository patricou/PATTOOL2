package com.pat.service;

import com.pat.controller.dto.LinksViewDTO;
import com.pat.repo.domain.CategoryLink;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.UrlLink;
import com.pat.util.MemberReferenceIds;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Builds the links page payload without loading {@code Friend} / full {@code Member} entities
 * (avoids DBRef hydration). Friend rows and link authors are read as BSON with projections.
 */
@Service
public class LinksViewService {

    private static final Logger log = LoggerFactory.getLogger(LinksViewService.class);

    private final MongoTemplate mongoTemplate;

    public LinksViewService(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    public LinksViewDTO buildLinksView(String userId) {
        long t0 = System.nanoTime();
        List<String> friendIds = loadFriendIdsRaw(userId);

        Query categoryQuery = buildCategoryQuery(userId);
        List<Document> categoryDocs = mongoTemplate.find(categoryQuery, Document.class, "categorylink");

        Query linkQuery = buildLinkQuery(userId, friendIds);
        List<Document> linkDocs = mongoTemplate.find(linkQuery, Document.class, "urllink");

        Set<String> authorIds = new HashSet<>();
        for (Document d : categoryDocs) {
            String aid = MemberReferenceIds.extractMemberId(rawAuthorFromCategoryOrLink(d));
            if (aid != null) {
                authorIds.add(aid);
            }
        }
        for (Document d : linkDocs) {
            String aid = MemberReferenceIds.extractMemberId(rawAuthorFromCategoryOrLink(d));
            if (aid != null) {
                authorIds.add(aid);
            }
        }

        Map<String, Member> authorMap = loadAuthors(authorIds);

        Map<String, Member> categoryAuthorFallback = new LinkedHashMap<>();
        for (Document d : categoryDocs) {
            Object catLinkId = d.get("categoryLinkID");
            if (catLinkId == null) {
                continue;
            }
            Member catAuthor = resolveMemberAuthor(rawAuthorFromCategoryOrLink(d), authorMap);
            if (catAuthor != null) {
                categoryAuthorFallback.put(catLinkId.toString(), catAuthor);
            }
        }

        List<CategoryLink> categories = new ArrayList<>();
        for (Document d : categoryDocs) {
            categories.add(categoryLinkFromDocument(d, authorMap));
        }

        List<UrlLink> links = new ArrayList<>();
        for (Document d : linkDocs) {
            links.add(urlLinkFromDocument(d, authorMap, categoryAuthorFallback));
        }

        Map<String, List<UrlLink>> linksByCategoryId = new LinkedHashMap<>();
        for (CategoryLink c : categories) {
            linksByCategoryId.put(c.getCategoryLinkID(), new ArrayList<>());
        }
        for (UrlLink link : links) {
            String catId = link.getCategoryLinkID();
            linksByCategoryId.computeIfAbsent(catId, k -> new ArrayList<>()).add(link);
        }

        if (log.isDebugEnabled()) {
            long ms = (System.nanoTime() - t0) / 1_000_000L;
            log.debug("links-view built in {} ms (categories={}, links={}, authors={})",
                    ms, categories.size(), links.size(), authorMap.size());
        }

        return new LinksViewDTO(categories, linksByCategoryId);
    }

    /**
     * Batch-resolve {@link Member}s the same way as for {@code /links-view} (for hydrating {@link UrlLink#getAuthor()}).
     * Keys are lowercase trimmed ids ({@link #normalizeIdKey}).
     */
    public Map<String, Member> resolveAuthorsByIds(Set<String> authorIds) {
        if (authorIds == null || authorIds.isEmpty()) {
            return Collections.emptyMap();
        }
        return loadAuthors(new HashSet<>(authorIds));
    }

    /**
     * Read friend rows as documents only; extract the other member id (no Friend/Member entities).
     */
    private List<String> loadFriendIdsRaw(String userId) {
        if (userId == null || userId.isEmpty()) {
            return Collections.emptyList();
        }
        Object uid = authorRefIdForQuery(userId);
        if (uid == null) {
            return Collections.emptyList();
        }
        Query q = new Query(new Criteria().orOperator(
                Criteria.where("user1.$id").is(uid),
                Criteria.where("user2.$id").is(uid)
        ));
        q.fields().include("user1").include("user2");
        List<Document> rows = mongoTemplate.find(q, Document.class, "friends");
        String selfNorm = normalizeIdKey(userId);
        Set<String> out = new HashSet<>();
        for (Document row : rows) {
            String id1 = MemberReferenceIds.extractMemberId(row.get("user1"));
            String id2 = MemberReferenceIds.extractMemberId(row.get("user2"));
            if (id1 != null && !normalizeIdKey(id1).equals(selfNorm)) {
                out.add(id1);
            }
            if (id2 != null && !normalizeIdKey(id2).equals(selfNorm)) {
                out.add(id2);
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * Load link/category authors: {@link Member} via {@link MongoTemplate} with an {@code _id} query that
     * matches both String and {@link ObjectId} encodings ( Spring {@code findAllById} often misses ObjectId _ids
     * when given hex strings). Then BSON projection fallback, then stubs.
     */
    private Map<String, Member> loadAuthors(Set<String> authorIds) {
        Map<String, Member> map = new HashMap<>();
        if (authorIds == null || authorIds.isEmpty()) {
            return map;
        }
        List<String> ids = new ArrayList<>();
        for (String id : authorIds) {
            if (id != null && !id.isBlank()) {
                ids.add(id.trim());
            }
        }
        if (ids.isEmpty()) {
            return map;
        }
        Criteria idCriteria = buildMemberIdInCriteria(ids);
        if (idCriteria != null) {
            List<Member> found = mongoTemplate.find(new Query(idCriteria), Member.class, "members");
            for (Member m : found) {
                if (m != null && m.getId() != null) {
                    map.put(normalizeIdKey(m.getId()), m);
                }
            }
        }
        Set<String> missing = new HashSet<>();
        for (String aid : ids) {
            if (!map.containsKey(normalizeIdKey(aid))) {
                missing.add(aid);
            }
        }
        if (!missing.isEmpty()) {
            map.putAll(loadAuthorsLiteFromDocuments(missing));
        }
        for (String aid : ids) {
            String k = normalizeIdKey(aid);
            if (!map.containsKey(k)) {
                Member stub = new Member();
                stub.setId(aid);
                map.put(k, stub);
            }
        }
        return map;
    }

    /**
     * Match {@code members._id} whether stored as {@link String} or {@link ObjectId}
     * (a single {@code $in} with mixed or wrongly typed ids often returns no rows).
     */
    private static Criteria buildMemberIdInCriteria(Collection<String> rawIds) {
        LinkedHashSet<String> strCandidates = new LinkedHashSet<>();
        List<ObjectId> oidCandidates = new ArrayList<>();
        for (String id : rawIds) {
            if (id == null || id.isEmpty()) {
                continue;
            }
            String trimmed = id.trim();
            strCandidates.add(trimmed);
            if (ObjectId.isValid(trimmed)) {
                try {
                    oidCandidates.add(new ObjectId(trimmed));
                } catch (IllegalArgumentException ignored) {
                    // keep string form only
                }
            }
        }
        if (strCandidates.isEmpty() && oidCandidates.isEmpty()) {
            return null;
        }
        List<Criteria> idBranches = new ArrayList<>();
        if (!strCandidates.isEmpty()) {
            idBranches.add(Criteria.where("_id").in(strCandidates));
        }
        if (!oidCandidates.isEmpty()) {
            idBranches.add(Criteria.where("_id").in(oidCandidates));
        }
        return idBranches.size() == 1
                ? idBranches.get(0)
                : new Criteria().orOperator(idBranches.toArray(new Criteria[0]));
    }

    /**
     * BSON projection fallback when {@link #loadAuthors} entity mapping still misses rows (legacy id shapes).
     */
    private Map<String, Member> loadAuthorsLiteFromDocuments(Set<String> authorIds) {
        if (authorIds.isEmpty()) {
            return Collections.emptyMap();
        }
        Criteria idCriteria = buildMemberIdInCriteria(authorIds);
        if (idCriteria == null) {
            return Collections.emptyMap();
        }
        Query q = new Query(idCriteria);
        q.fields().include("_id").include("userName").include("firstName").include("lastName").include("addressEmail");
        List<Document> docs = mongoTemplate.find(q, Document.class, "members");
        Map<String, Member> map = new HashMap<>();
        for (Document d : docs) {
            String id = documentIdToString(d.get("_id"));
            if (id == null) {
                continue;
            }
            Member m = memberFromAuthorDocument(d, id);
            map.put(normalizeIdKey(id), m);
        }
        return map;
    }

    /** Best-effort display fields from members collection (legacy keys / empty username). */
    private static Member memberFromAuthorDocument(Document d, String id) {
        Member m = new Member();
        m.setId(id);
        m.setUserName(firstNonBlankString(d, "userName", "username", "login"));
        m.setFirstName(firstNonBlankString(d, "firstName", "first_name"));
        m.setLastName(firstNonBlankString(d, "lastName", "last_name"));
        m.setAddressEmail(firstNonBlankString(d, "addressEmail", "address_email", "email"));
        m.setPositions(Collections.emptyList());
        return m;
    }

    private static String firstNonBlankString(Document d, String... keys) {
        for (String k : keys) {
            Object v = d.get(k);
            if (v == null) {
                continue;
            }
            String s = v.toString().trim();
            if (!s.isEmpty()) {
                return s;
            }
        }
        return null;
    }

    private static String normalizeIdKey(String id) {
        return id == null ? "" : id.trim().toLowerCase();
    }

    private static Criteria visibilityPublicOrMissingCriteria() {
        return new Criteria().orOperator(
                Criteria.where("visibility").exists(false),
                Criteria.where("visibility").is(null),
                Criteria.where("visibility").is("public")
        );
    }

    private static Object authorRefIdForQuery(String id) {
        if (id == null || id.isEmpty()) {
            return null;
        }
        if (ObjectId.isValid(id)) {
            try {
                return new ObjectId(id);
            } catch (IllegalArgumentException ignored) {
                return id;
            }
        }
        return id;
    }

    private static Query buildCategoryQuery(String userId) {
        Query q = new Query();
        if (userId != null && !userId.isEmpty()) {
            Object uid = authorRefIdForQuery(userId);
            if (uid == null) {
                q.addCriteria(visibilityPublicOrMissingCriteria());
            } else {
                q.addCriteria(new Criteria().orOperator(
                        visibilityPublicOrMissingCriteria(),
                        new Criteria().andOperator(
                                Criteria.where("visibility").is("private"),
                                Criteria.where("author.$id").is(uid)
                        )
                ));
            }
        } else {
            q.addCriteria(visibilityPublicOrMissingCriteria());
        }
        q.with(Sort.by(Sort.Direction.ASC, "categoryName"));
        return q;
    }

    private static Query buildLinkQuery(String userId, List<String> friendIds) {
        Query q = new Query();
        if (userId == null || userId.isEmpty()) {
            q.addCriteria(visibilityPublicOrMissingCriteria());
        } else {
            Object uid = authorRefIdForQuery(userId);
            if (uid == null) {
                q.addCriteria(visibilityPublicOrMissingCriteria());
            } else {
                Criteria pub = visibilityPublicOrMissingCriteria();
                Criteria priv = new Criteria().andOperator(
                        Criteria.where("visibility").is("private"),
                        Criteria.where("author.$id").is(uid)
                );
                LinkedHashSet<Object> selfAndFriends = new LinkedHashSet<>();
                selfAndFriends.add(uid);
                if (friendIds != null) {
                    for (String fid : friendIds) {
                        Object ref = authorRefIdForQuery(fid);
                        if (ref != null) {
                            selfAndFriends.add(ref);
                        }
                    }
                }
                Criteria friendsBranch = new Criteria().andOperator(
                        Criteria.where("visibility").is("friends"),
                        Criteria.where("author.$id").in(new ArrayList<>(selfAndFriends))
                );
                q.addCriteria(new Criteria().orOperator(pub, priv, friendsBranch));
            }
        }
        q.with(Sort.by(Sort.Direction.ASC, "linkName"));
        return q;
    }

    /**
     * Legacy / mixed shapes: nested {@code author}, plain id, or alternate field names.
     */
    private static Object rawAuthorFromCategoryOrLink(Document d) {
        if (d == null) {
            return null;
        }
        String[] keys = {
                "author", "Author", "authorId", "author_id",
                "owner", "ownerId", "owner_id",
                "userId", "user_id", "memberId", "member_id",
                "createdBy", "created_by"
        };
        for (String k : keys) {
            Object v = d.get(k);
            if (v != null) {
                return v;
            }
        }
        return null;
    }

    /**
     * Resolves {@link Member} from raw BSON: DBRef ({@code $ref}/$id), embedded subdocument,
     * or plain {@link ObjectId} / string id (common when {@code @DBRef} was not used).
     */
    private static Member resolveMemberAuthor(Object rawAuthor, Map<String, Member> authorMap) {
        if (rawAuthor == null) {
            return null;
        }
        if (rawAuthor instanceof Document adoc) {
            boolean dbRef = adoc.containsKey("$id") || adoc.containsKey("$ref");
            String aid = MemberReferenceIds.extractMemberId(rawAuthor);
            if (!dbRef) {
                Member inline = memberFromAuthorDocument(adoc, aid != null ? aid : "");
                if (inline.getUserName() != null || inline.getFirstName() != null || inline.getLastName() != null
                        || inline.getAddressEmail() != null) {
                    if ((inline.getId() == null || inline.getId().isBlank()) && aid != null) {
                        inline.setId(aid);
                    }
                    return inline;
                }
            }
            if (aid == null) {
                return null;
            }
            return memberFromMapOrStub(aid, authorMap);
        }
        String aid = MemberReferenceIds.extractMemberId(rawAuthor);
        if (aid == null) {
            return null;
        }
        return memberFromMapOrStub(aid, authorMap);
    }

    private static Member memberFromMapOrStub(String aid, Map<String, Member> authorMap) {
        Member m = authorMap.get(normalizeIdKey(aid));
        if (m != null) {
            return m;
        }
        Member stub = new Member();
        stub.setId(aid);
        return stub;
    }

    private static String documentIdToString(Object idObj) {
        if (idObj instanceof ObjectId oid) {
            return oid.toHexString();
        }
        return idObj != null ? idObj.toString() : null;
    }

    private static CategoryLink categoryLinkFromDocument(Document d, Map<String, Member> authorMap) {
        CategoryLink c = new CategoryLink();
        c.setId(documentIdToString(d.get("_id")));
        Object catLinkId = d.get("categoryLinkID");
        if (catLinkId != null) {
            c.setCategoryLinkID(catLinkId.toString());
        }
        c.setCategoryName(d.getString("categoryName"));
        c.setCategoryDescription(d.getString("categoryDescription"));
        c.setVisibility(d.getString("visibility"));
        Member author = resolveMemberAuthor(rawAuthorFromCategoryOrLink(d), authorMap);
        if (author != null) {
            c.setAuthor(author);
        }
        return c;
    }

    private static UrlLink urlLinkFromDocument(Document d, Map<String, Member> authorMap,
            Map<String, Member> categoryAuthorFallback) {
        UrlLink link = new UrlLink();
        link.setId(documentIdToString(d.get("_id")));
        Object urlLinkId = d.get("urlLinkID");
        if (urlLinkId != null) {
            link.setUrlLinkID(urlLinkId.toString());
        }
        link.setLinkDescription(d.getString("linkDescription"));
        link.setLinkName(d.getString("linkName"));
        link.setUrl(d.getString("url"));
        Object catId = d.get("categoryLinkID");
        if (catId != null) {
            link.setCategoryLinkID(catId.toString());
        }
        link.setVisibility(d.getString("visibility"));
        Object obpl = d.get("openByProxyLan");
        if (obpl instanceof Boolean b) {
            link.setOpenByProxyLan(b);
        }
        Member author = resolveMemberAuthor(rawAuthorFromCategoryOrLink(d), authorMap);
        if (author == null && catId != null && categoryAuthorFallback != null) {
            author = categoryAuthorFallback.get(catId.toString());
        }
        if (author != null) {
            link.setAuthor(author);
        }
        return link;
    }
}
