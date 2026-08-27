package com.pat.service.news;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses RSS 2.0 and Atom documents into the NewsAPI-shaped article maps
 * the Angular News page already consumes. XXE is disabled.
 */
final class RssFeedParser {

    static final int MAX_ITEMS_PER_FEED = 80;

    private static final Pattern IMG_SRC = Pattern.compile(
            "<img[^>]+src=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");
    private static final DateTimeFormatter[] DATE_FORMATS = new DateTimeFormatter[] {
            DateTimeFormatter.RFC_1123_DATE_TIME,
            DateTimeFormatter.ISO_OFFSET_DATE_TIME,
            DateTimeFormatter.ISO_INSTANT,
            DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss Z", Locale.ENGLISH),
            DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.ENGLISH),
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ENGLISH),
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss", Locale.ENGLISH)
    };

    private RssFeedParser() {}

    static List<Map<String, Object>> parse(byte[] xmlBytes, RssFeed feed) {
        if (xmlBytes == null || xmlBytes.length == 0) {
            return List.of();
        }
        Document doc;
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setExpandEntityReferences(false);
            factory.setXIncludeAware(false);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            doc = factory.newDocumentBuilder().parse(new ByteArrayInputStream(xmlBytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("Not a readable RSS/Atom document", e);
        }

        Element root = doc.getDocumentElement();
        if (root == null) {
            return List.of();
        }
        String rootLocal = localName(root);
        List<Map<String, Object>> articles = new ArrayList<>();
        if ("rss".equals(rootLocal) || "RDF".equals(rootLocal) || hasChild(root, "channel")) {
            Element channel = firstChild(root, "channel");
            String channelTitle = channel != null ? text(channel, "title") : feed.name();
            Element itemsParent = channel != null ? channel : root;
            for (Element item : children(itemsParent, "item")) {
                Map<String, Object> article = toArticle(item, feed, channelTitle, false);
                if (article != null) {
                    articles.add(article);
                    if (articles.size() >= MAX_ITEMS_PER_FEED) break;
                }
            }
        } else {
            String feedTitle = text(root, "title");
            if (feedTitle == null || feedTitle.isBlank()) feedTitle = feed.name();
            for (Element entry : children(root, "entry")) {
                Map<String, Object> article = toArticle(entry, feed, feedTitle, true);
                if (article != null) {
                    articles.add(article);
                    if (articles.size() >= MAX_ITEMS_PER_FEED) break;
                }
            }
        }
        return articles;
    }

    /**
     * Best-effort channel/feed title from a raw document, used when the user
     * pastes a URL and we need a display name.
     */
    static String extractTitle(byte[] xmlBytes) {
        try {
            List<Map<String, Object>> dummy = parse(xmlBytes,
                    new RssFeed("tmp", "RSS", "", "", "general", "", "", ""));
            if (!dummy.isEmpty()) {
                Object src = dummy.get(0).get("source");
                if (src instanceof Map<?, ?> m && m.get("name") instanceof String name && !name.isBlank()) {
                    return name;
                }
            }
        } catch (Exception ignored) {
            // fall through
        }
        try {
            String s = new String(xmlBytes, StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("<(?:atom:)?title[^>]*>([^<]+)</(?:atom:)?title>",
                    Pattern.CASE_INSENSITIVE).matcher(s);
            if (m.find()) return decodeEntities(m.group(1).trim());
        } catch (Exception ignored) {
            // ignore
        }
        return null;
    }

    private static Map<String, Object> toArticle(Element item, RssFeed feed, String sourceName, boolean atom) {
        String title = text(item, "title");
        String link = atom ? atomLink(item) : firstText(item, "link", "guid");
        if ((title == null || title.isBlank()) && (link == null || link.isBlank())) {
            return null;
        }
        if (title == null || title.isBlank()) title = link;
        String rawDesc = firstText(item, "description", "summary", "content", "encoded");
        String description = stripHtml(rawDesc);
        String image = imageUrl(item, rawDesc);
        String published = firstText(item, "pubDate", "published", "updated", "date");
        String author = firstText(item, "creator", "author", "name");
        if (author != null && author.length() > 120) author = author.substring(0, 120);

        Map<String, Object> source = new LinkedHashMap<>();
        source.put("id", feed.id());
        source.put("name", sourceName != null && !sourceName.isBlank() ? sourceName : feed.name());

        Map<String, Object> article = new LinkedHashMap<>();
        article.put("source", source);
        article.put("author", blankToNull(author));
        article.put("title", decodeEntities(title.trim()));
        article.put("description", description);
        article.put("url", link != null ? link.trim() : feed.website());
        article.put("urlToImage", image);
        article.put("publishedAt", toIso(published));
        article.put("content", description);
        return article;
    }

    private static String atomLink(Element entry) {
        String alt = null;
        String any = null;
        for (Element link : children(entry, "link")) {
            String href = attr(link, "href");
            if (href == null || href.isBlank()) continue;
            String rel = attr(link, "rel");
            if (rel == null || rel.isBlank() || "alternate".equalsIgnoreCase(rel)) {
                alt = href;
                break;
            }
            if (any == null) any = href;
        }
        return alt != null ? alt : any;
    }

    private static String imageUrl(Element item, String html) {
        for (Element enc : children(item, "enclosure")) {
            String type = attr(enc, "type");
            String url = attr(enc, "url");
            if (url != null && type != null && type.toLowerCase(Locale.ROOT).startsWith("image/")) {
                return url;
            }
        }
        for (String local : List.of("content", "thumbnail", "image")) {
            for (Element el : children(item, local)) {
                String url = firstNonBlank(attr(el, "url"), attr(el, "href"));
                String medium = attr(el, "medium");
                String type = attr(el, "type");
                boolean looksImage = (medium != null && medium.equalsIgnoreCase("image"))
                        || (type != null && type.toLowerCase(Locale.ROOT).startsWith("image/"))
                        || "thumbnail".equals(local)
                        || "image".equals(local);
                if (url != null && looksImage) return url;
            }
        }
        if (html != null) {
            Matcher m = IMG_SRC.matcher(html);
            if (m.find()) return m.group(1).trim();
        }
        return null;
    }

    private static String toIso(String raw) {
        if (raw == null || raw.isBlank()) {
            return Instant.now().toString();
        }
        String s = raw.trim();
        for (DateTimeFormatter fmt : DATE_FORMATS) {
            try {
                return OffsetDateTime.parse(s, fmt).withOffsetSameInstant(ZoneOffset.UTC).toString();
            } catch (DateTimeParseException ignored) {
                // try next
            }
            try {
                return Instant.from(fmt.parse(s)).toString();
            } catch (Exception ignored) {
                // try next
            }
        }
        try {
            return Instant.parse(s).toString();
        } catch (Exception ignored) {
            return Instant.now().toString();
        }
    }

    private static String stripHtml(String raw) {
        if (raw == null) return null;
        String plain = HTML_TAG.matcher(raw).replaceAll(" ");
        plain = decodeEntities(plain);
        plain = plain.replaceAll("\\s+", " ").trim();
        if (plain.isEmpty()) return null;
        if (plain.length() > 600) plain = plain.substring(0, 597) + "…";
        return plain;
    }

    private static String decodeEntities(String s) {
        if (s == null) return null;
        return s.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&apos;", "'")
                .replace("&nbsp;", " ");
    }

    private static String text(Element parent, String local) {
        Element child = firstChild(parent, local);
        if (child == null) return null;
        String t = child.getTextContent();
        return t == null ? null : t.trim();
    }

    private static String firstText(Element parent, String... locals) {
        for (String local : locals) {
            String t = text(parent, local);
            if (t != null && !t.isBlank()) return t;
        }
        return null;
    }

    private static Element firstChild(Element parent, String local) {
        List<Element> all = children(parent, local);
        return all.isEmpty() ? null : all.get(0);
    }

    private static boolean hasChild(Element parent, String local) {
        return !children(parent, local).isEmpty();
    }

    private static List<Element> children(Element parent, String local) {
        List<Element> out = new ArrayList<>();
        NodeList nodes = parent.getChildNodes();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node n = nodes.item(i);
            if (n instanceof Element el && local.equalsIgnoreCase(localName(el))) {
                out.add(el);
            }
        }
        return out;
    }

    private static String localName(Element el) {
        String local = el.getLocalName();
        if (local != null && !local.isBlank()) return local;
        String tag = el.getTagName();
        int colon = tag.indexOf(':');
        return colon >= 0 ? tag.substring(colon + 1) : tag;
    }

    private static String attr(Element el, String name) {
        if (el.hasAttribute(name)) return el.getAttribute(name);
        // namespaced attributes (media:url etc. are usually unprefixed url=)
        return null;
    }

    private static String firstNonBlank(String... values) {
        if (values == null) return null;
        for (String v : values) {
            if (v != null && !v.isBlank()) return v;
        }
        return null;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
