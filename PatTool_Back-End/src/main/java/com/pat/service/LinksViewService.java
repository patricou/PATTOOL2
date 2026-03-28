package com.pat.service;

import com.pat.controller.dto.LinksViewDTO;
import com.pat.repo.domain.CategoryLink;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.UrlLink;
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
            String aid = extractDbRefId(d.get("author"));
            if (aid != null) {
                authorIds.add(aid);
            }
        }
        for (Document d : linkDocs) {
            String aid = extractDbRefId(d.get("author"));
            if (aid != null) {
                authorIds.add(aid);
            }
        }

        Map<String, Member> authorMap = loadAuthorsLite(authorIds);

        List<CategoryLink> categories = new ArrayList<>();
        for (Document d : categoryDocs) {
            categories.add(categoryLinkFromDocument(d, authorMap));
        }

        List<UrlLink> links = new ArrayList<>();
        for (Document d : linkDocs) {
            links.add(urlLinkFromDocument(d, authorMap));
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
            String id1 = extractDbRefId(row.get("user1"));
            String id2 = extractDbRefId(row.get("user2"));
            if (id1 != null && !normalizeIdKey(id1).equals(selfNorm)) {
                out.add(id1);
            }
            if (id2 != null && !normalizeIdKey(id2).equals(selfNorm)) {
                out.add(id2);
            }
        }
        return new ArrayList<>(out);
    }

    private Map<String, Member> loadAuthorsLite(Set<String> authorIds) {
        if (authorIds.isEmpty()) {
            return Collections.emptyMap();
        }
        LinkedHashSet<Object> inVals = new LinkedHashSet<>();
        for (String id : authorIds) {
            Object v = authorRefIdForQuery(id);
            if (v != null) {
                inVals.add(v);
            }
        }
        if (inVals.isEmpty()) {
            return Collections.emptyMap();
        }
        Query q = new Query(Criteria.where("_id").in(new ArrayList<>(inVals)));
        q.fields().include("_id").include("userName").include("firstName").include("lastName");
        List<Document> docs = mongoTemplate.find(q, Document.class, "members");
        Map<String, Member> map = new HashMap<>();
        for (Document d : docs) {
            String id = documentIdToString(d.get("_id"));
            if (id == null) {
                continue;
            }
            Member m = new Member();
            m.setId(id);
            m.setUserName(d.getString("userName"));
            m.setFirstName(d.getString("firstName"));
            m.setLastName(d.getString("lastName"));
            m.setPositions(Collections.emptyList());
            map.put(normalizeIdKey(id), m);
        }
        return map;
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

    private static String extractDbRefId(Object refVal) {
        if (refVal == null) {
            return null;
        }
        if (refVal instanceof Document doc) {
            Object id = doc.get("$id");
            if (id instanceof ObjectId oid) {
                return oid.toHexString();
            }
            return id != null ? id.toString() : null;
        }
        if (refVal instanceof ObjectId oid) {
            return oid.toHexString();
        }
        return refVal.toString();
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
        String aid = extractDbRefId(d.get("author"));
        if (aid != null) {
            Member m = authorMap.get(normalizeIdKey(aid));
            if (m != null) {
                c.setAuthor(m);
            } else {
                Member stub = new Member();
                stub.setId(aid);
                c.setAuthor(stub);
            }
        }
        return c;
    }

    private static UrlLink urlLinkFromDocument(Document d, Map<String, Member> authorMap) {
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
        String aid = extractDbRefId(d.get("author"));
        if (aid != null) {
            Member m = authorMap.get(normalizeIdKey(aid));
            if (m != null) {
                link.setAuthor(m);
            } else {
                Member stub = new Member();
                stub.setId(aid);
                link.setAuthor(stub);
            }
        }
        return link;
    }
}
