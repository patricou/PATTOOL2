package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.CodeRepoAnalyzeResponse;
import com.pat.controller.dto.CodeRepoFileDto;
import com.pat.controller.dto.CodeRepoSearchHitDto;
import com.pat.controller.dto.CodeRepoSearchResponse;
import com.pat.controller.dto.CodeRepoTreeEntryDto;
import com.pat.controller.dto.CodeRepoTreeResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fetches public source files from GitHub or GitLab for defensive code review.
 * Only hardcoded API hosts are contacted (no arbitrary URL fetch).
 */
@Service
public class CodeRepoWorldService {

    private static final Logger log = LoggerFactory.getLogger(CodeRepoWorldService.class);

    private static final int MAX_FILES = 20;
    private static final int MAX_FILE_BYTES = 80_000;
    private static final int MAX_TOTAL_BYTES = 280_000;
    private static final long TREE_CACHE_MS = 5 * 60_000L;

    private static final Set<String> SKIP_DIR_SEGMENTS = Set.of(
            "node_modules", "dist", "build", "target", "vendor", ".git", ".svn",
            "__pycache__", ".next", "coverage", "out", "bin", "obj", ".gradle"
    );

    private static final Map<String, String> EXT_LANGUAGE = new LinkedHashMap<>();

    static {
        EXT_LANGUAGE.put(".java", "java");
        EXT_LANGUAGE.put(".kt", "kotlin");
        EXT_LANGUAGE.put(".py", "python");
        EXT_LANGUAGE.put(".ts", "typescript");
        EXT_LANGUAGE.put(".tsx", "typescript");
        EXT_LANGUAGE.put(".js", "javascript");
        EXT_LANGUAGE.put(".jsx", "javascript");
        EXT_LANGUAGE.put(".go", "go");
        EXT_LANGUAGE.put(".rs", "rust");
        EXT_LANGUAGE.put(".rb", "ruby");
        EXT_LANGUAGE.put(".php", "php");
        EXT_LANGUAGE.put(".cs", "csharp");
        EXT_LANGUAGE.put(".c", "c");
        EXT_LANGUAGE.put(".h", "c");
        EXT_LANGUAGE.put(".cpp", "cpp");
        EXT_LANGUAGE.put(".cc", "cpp");
        EXT_LANGUAGE.put(".hpp", "cpp");
        EXT_LANGUAGE.put(".swift", "swift");
        EXT_LANGUAGE.put(".scala", "scala");
        EXT_LANGUAGE.put(".sql", "sql");
        EXT_LANGUAGE.put(".sh", "shell");
        EXT_LANGUAGE.put(".ps1", "powershell");
        EXT_LANGUAGE.put(".yml", "yaml");
        EXT_LANGUAGE.put(".yaml", "yaml");
        EXT_LANGUAGE.put(".xml", "xml");
        EXT_LANGUAGE.put(".html", "html");
        EXT_LANGUAGE.put(".css", "css");
        EXT_LANGUAGE.put(".vue", "vue");
        EXT_LANGUAGE.put(".tf", "terraform");
        EXT_LANGUAGE.put(".md", "markdown");
        EXT_LANGUAGE.put(".json", "json");
        EXT_LANGUAGE.put(".properties", "properties");
        EXT_LANGUAGE.put(".gradle", "groovy");
    }

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String githubToken;
    private final String gitlabToken;
    private final Map<String, CachedFlatTree> githubTreeCache = new ConcurrentHashMap<>();
    private final Map<String, CodeRepoTreeResponse> githubDirCache = new ConcurrentHashMap<>();
    private final Map<String, String> githubDirSha = new ConcurrentHashMap<>();

    public CodeRepoWorldService(
            @Qualifier(RestTemplateConfig.CODE_REPO_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper,
            @Value("${code.github.token:}") String githubToken,
            @Value("${code.gitlab.token:}") String gitlabToken) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.githubToken = githubToken != null ? githubToken.trim() : "";
        this.gitlabToken = gitlabToken != null ? gitlabToken.trim() : "";
    }

    public CodeRepoAnalyzeResponse analyze(String rawUrl, String branchHint) {
        ParsedRepo parsed = parse(rawUrl);
        if ("github".equals(parsed.host)) {
            return fetchGithub(parsed, branchHint);
        }
        return fetchGitlab(parsed, branchHint);
    }

    public CodeRepoSearchResponse search(String rawQuery, String hostHint, Integer pageHint) {
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.length() < 2) {
            throw new IllegalArgumentException("Search query is too short");
        }
        if (!query.matches("[A-Za-z0-9 ._\\-:+#@/\"'><=()]+")) {
            throw new IllegalArgumentException("Search query contains invalid characters");
        }
        int page = pageHint == null ? 1 : Math.max(1, Math.min(10, pageHint));
        String host = hostHint == null ? "all" : hostHint.trim().toLowerCase(Locale.ROOT);
        boolean wantStars = query.toLowerCase(Locale.ROOT).contains("stars:");
        String nameToken = primarySearchToken(query);
        Map<String, CodeRepoSearchHitDto> unique = new LinkedHashMap<>();
        if ("gitlab".equals(host) || "all".equals(host)) {
            addUnique(unique, searchGitlab(keywordsForGitlab(query), page));
        }
        if ("github".equals(host) || "all".equals(host)) {
            if (StringUtils.hasText(nameToken) && !query.toLowerCase(Locale.ROOT).contains("in:name")) {
                addUnique(unique, searchGithub(nameToken + " in:name", page, false));
            }
            addUnique(unique, searchGithub(query, page, wantStars));
        }
        List<CodeRepoSearchHitDto> items = new ArrayList<>(unique.values());
        items.sort(nameMatchComparator(nameToken));
        CodeRepoSearchResponse out = new CodeRepoSearchResponse();
        out.setItems(items);
        out.setTotal(items.size());
        return out;
    }

    static String keywordsForGitlab(String query) {
        if (!StringUtils.hasText(query)) {
            return query;
        }
        String stripped = query.replaceAll("(?i)\\b(?:language|lang|stars|topic|size|forks|license|org|user):\\S+", " ");
        stripped = stripped.replaceAll("[\"'><=()]", " ").replaceAll("\\s+", " ").trim();
        return StringUtils.hasText(stripped) ? stripped : query.trim();
    }

    private static void addUnique(Map<String, CodeRepoSearchHitDto> unique, List<CodeRepoSearchHitDto> hits) {
        for (CodeRepoSearchHitDto hit : hits) {
            if (hit == null || !StringUtils.hasText(hit.getFullName())) {
                continue;
            }
            String key = (hit.getHost() + ":" + hit.getFullName()).toLowerCase(Locale.ROOT);
            unique.putIfAbsent(key, hit);
        }
    }

    static String primarySearchToken(String query) {
        if (!StringUtils.hasText(query)) {
            return "";
        }
        String stripped = query.replaceAll(
                "(?i)\\b(?:language|lang|stars|topic|size|forks|license|org|user|in):\\S+", " ");
        stripped = stripped.replaceAll("[\"'><=()]", " ");
        String best = "";
        for (String part : stripped.split("\\s+")) {
            if (part.matches("[A-Za-z][A-Za-z0-9._-]{1,80}") && part.length() > best.length()) {
                best = part;
            }
        }
        return best;
    }

    static Comparator<CodeRepoSearchHitDto> nameMatchComparator(String token) {
        return (a, b) -> {
            int cmp = Integer.compare(nameScore(b, token), nameScore(a, token));
            if (cmp != 0) {
                return cmp;
            }
            return Integer.compare(b.getStars(), a.getStars());
        };
    }

    static int nameScore(CodeRepoSearchHitDto hit, String token) {
        if (!StringUtils.hasText(token) || hit == null) {
            return 0;
        }
        String t = token.toLowerCase(Locale.ROOT);
        String name = hit.getName() == null ? "" : hit.getName().toLowerCase(Locale.ROOT);
        String full = hit.getFullName() == null ? "" : hit.getFullName().toLowerCase(Locale.ROOT);
        if (name.equals(t) || full.equalsIgnoreCase(t)) {
            return 1000;
        }
        if (name.startsWith(t) && name.substring(t.length()).matches("\\d+")) {
            return 950;
        }
        if (name.startsWith(t)) {
            return 800;
        }
        if (name.contains(t) || full.contains("/" + t)) {
            return 600;
        }
        if (full.contains(t)) {
            return 400;
        }
        return 0;
    }

    public CodeRepoTreeResponse listTree(String rawUrl, String branchHint, String rawPath) {
        ParsedRepo parsed = parse(rawUrl);
        String rel = sanitizeRelPath(rawPath);
        if ("github".equals(parsed.host)) {
            return listGithubTree(parsed, branchHint, rel);
        }
        return listGitlabTree(parsed, branchHint, rel);
    }

    public CodeRepoTreeResponse treeIndex(String rawUrl, String branchHint) {
        ParsedRepo parsed = parse(rawUrl);
        if ("gitlab".equals(parsed.host)) {
            return listGitlabTree(parsed, branchHint, "");
        }
        String htmlUrl = "https://github.com/" + parsed.owner + "/" + parsed.name;
        String branch = resolveGithubBranch(parsed, branchHint, htmlUrl).branch;
        CachedFlatTree flat = loadGithubFlatTree(parsed, branch);
        CodeRepoTreeResponse out = treeResponse("github", parsed, htmlUrl, branch, "", entriesAt(flat.nodes, ""));
        List<CodeRepoTreeEntryDto> nodes = new ArrayList<>(Math.min(flat.nodes.size(), 20_000));
        int n = 0;
        for (FlatNode node : flat.nodes) {
            if (n >= 20_000) {
                break;
            }
            String name = node.path();
            int slash = name.lastIndexOf('/');
            if (slash >= 0) {
                name = name.substring(slash + 1);
            }
            nodes.add(new CodeRepoTreeEntryDto(name, node.path(), node.dir() ? "dir" : "file", node.size()));
            n++;
        }
        out.setNodes(nodes);
        return out;
    }

    public CodeRepoFileDto readFile(String rawUrl, String branchHint, String rawPath) {
        ParsedRepo parsed = parse(rawUrl);
        String rel = sanitizeRelPath(rawPath);
        if (!StringUtils.hasText(rel)) {
            throw new IllegalArgumentException("File path is required");
        }
        if ("github".equals(parsed.host)) {
            return readGithubFile(parsed, branchHint, rel);
        }
        return readGitlabFile(parsed, branchHint, rel);
    }

    private CodeRepoAnalyzeResponse fetchGithub(ParsedRepo parsed, String branchHint) {
        CodeRepoAnalyzeResponse out = baseResponse(parsed);
        JsonNode repo = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name,
                githubHeaders());
        if (repo.has("message") && !repo.has("full_name")) {
            throw new IllegalArgumentException(repo.path("message").asText("Repository not found"));
        }
        out.setDescription(textOrNull(repo.path("description")));
        out.setHtmlUrl(textOrNull(repo.path("html_url")));
        String branch = firstNonBlank(branchHint, parsed.branch, repo.path("default_branch").asText("main"));
        out.setDefaultBranch(branch);

        JsonNode treeDoc = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name
                        + "/git/trees/" + encodePath(branch) + "?recursive=1",
                githubHeaders());
        boolean truncated = treeDoc.path("truncated").asBoolean(false);
        List<TreeEntry> candidates = new ArrayList<>();
        JsonNode tree = treeDoc.path("tree");
        if (tree.isArray()) {
            for (JsonNode n : tree) {
                if (!"blob".equals(n.path("type").asText())) {
                    continue;
                }
                String path = n.path("path").asText("");
                int size = n.path("size").asInt(0);
                if (!isCandidate(path, size)) {
                    continue;
                }
                candidates.add(new TreeEntry(path, n.path("sha").asText(""), size));
            }
        }
        candidates.sort(treeComparator());
        int total = 0;
        int taken = 0;
        for (TreeEntry e : candidates) {
            if (taken >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
                truncated = true;
                break;
            }
            try {
                JsonNode blob = getJson(
                        "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name
                                + "/git/blobs/" + e.sha,
                        githubHeaders());
                String content = decodeGithubBlob(blob.path("content").asText(""), blob.path("encoding").asText("base64"));
                if (!StringUtils.hasText(content)) {
                    continue;
                }
                if (content.length() > MAX_FILE_BYTES) {
                    content = content.substring(0, MAX_FILE_BYTES);
                    truncated = true;
                }
                out.getFiles().add(new CodeRepoFileDto(e.path, languageOf(e.path), content, content.length()));
                total += content.length();
                taken++;
            } catch (RuntimeException ex) {
                log.debug("Skip GitHub blob {}: {}", e.path, ex.getMessage());
            }
        }
        out.setTruncated(truncated);
        out.setMessage(truncated
                ? "A subset of source files was loaded for review (size limits)."
                : null);
        return out;
    }

    private CodeRepoAnalyzeResponse fetchGitlab(ParsedRepo parsed, String branchHint) {
        CodeRepoAnalyzeResponse out = baseResponse(parsed);
        String projectPath = encodePath(parsed.owner + "/" + parsed.name);
        JsonNode project = getJson("https://gitlab.com/api/v4/projects/" + projectPath, gitlabHeaders());
        out.setDescription(textOrNull(project.path("description")));
        out.setHtmlUrl(textOrNull(project.path("web_url")));
        String branch = firstNonBlank(branchHint, parsed.branch, project.path("default_branch").asText("main"));
        out.setDefaultBranch(branch);

        JsonNode tree = getJson(
                "https://gitlab.com/api/v4/projects/" + projectPath
                        + "/repository/tree?recursive=true&per_page=100&ref=" + encodePath(branch),
                gitlabHeaders());
        List<TreeEntry> candidates = new ArrayList<>();
        if (tree.isArray()) {
            for (JsonNode n : tree) {
                if (!"blob".equals(n.path("type").asText())) {
                    continue;
                }
                String path = n.path("path").asText("");
                if (!isCandidate(path, 1)) {
                    continue;
                }
                candidates.add(new TreeEntry(path, "", 0));
            }
        }
        candidates.sort(treeComparator());
        boolean truncated = candidates.size() > MAX_FILES;
        int total = 0;
        int taken = 0;
        for (TreeEntry e : candidates) {
            if (taken >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
                truncated = true;
                break;
            }
            try {
                String rawUrl = "https://gitlab.com/api/v4/projects/" + projectPath
                        + "/repository/files/" + encodePath(e.path) + "/raw?ref=" + encodePath(branch);
                String content = getText(rawUrl, gitlabHeaders());
                if (!StringUtils.hasText(content)) {
                    continue;
                }
                if (content.length() > MAX_FILE_BYTES) {
                    content = content.substring(0, MAX_FILE_BYTES);
                    truncated = true;
                }
                out.getFiles().add(new CodeRepoFileDto(e.path, languageOf(e.path), content, content.length()));
                total += content.length();
                taken++;
            } catch (RuntimeException ex) {
                log.debug("Skip GitLab file {}: {}", e.path, ex.getMessage());
            }
        }
        out.setTruncated(truncated);
        out.setMessage(truncated
                ? "A subset of source files was loaded for review (size limits)."
                : null);
        return out;
    }

    private List<CodeRepoSearchHitDto> searchGithub(String query, int page, boolean sortByStars) {
        String url = "https://api.github.com/search/repositories?q=" + encodePath(query)
                + "&per_page=20&page=" + page;
        if (sortByStars) {
            url += "&sort=stars&order=desc";
        }
        JsonNode doc = getJson(url, githubHeaders());
        List<CodeRepoSearchHitDto> out = new ArrayList<>();
        JsonNode items = doc.path("items");
        if (!items.isArray()) {
            return out;
        }
        for (JsonNode n : items) {
            CodeRepoSearchHitDto hit = new CodeRepoSearchHitDto();
            hit.setHost("github");
            String full = n.path("full_name").asText("");
            int slash = full.indexOf('/');
            hit.setOwner(slash > 0 ? full.substring(0, slash) : n.path("owner").path("login").asText(""));
            hit.setName(slash > 0 ? full.substring(slash + 1) : n.path("name").asText(""));
            hit.setFullName(full);
            hit.setDescription(textOrNull(n.path("description")));
            hit.setLanguage(textOrNull(n.path("language")));
            hit.setHtmlUrl(textOrNull(n.path("html_url")));
            hit.setDefaultBranch(n.path("default_branch").asText("main"));
            hit.setStars(n.path("stargazers_count").asInt(0));
            if (StringUtils.hasText(hit.getHtmlUrl()) && StringUtils.hasText(hit.getName())) {
                out.add(hit);
            }
        }
        return out;
    }

    private List<CodeRepoSearchHitDto> searchGitlab(String query, int page) {
        JsonNode doc = getJson(
                "https://gitlab.com/api/v4/projects?search=" + encodePath(query)
                        + "&order_by=star_count&sort=desc&simple=true&per_page=20&page=" + page,
                gitlabHeaders());
        List<CodeRepoSearchHitDto> out = new ArrayList<>();
        if (!doc.isArray()) {
            return out;
        }
        for (JsonNode n : doc) {
            CodeRepoSearchHitDto hit = new CodeRepoSearchHitDto();
            hit.setHost("gitlab");
            String path = n.path("path_with_namespace").asText("");
            int slash = path.lastIndexOf('/');
            hit.setOwner(slash > 0 ? path.substring(0, slash) : n.path("namespace").path("path").asText(""));
            hit.setName(n.path("path").asText(""));
            hit.setFullName(path);
            hit.setDescription(textOrNull(n.path("description")));
            hit.setHtmlUrl(textOrNull(n.path("web_url")));
            hit.setDefaultBranch(n.path("default_branch").asText("main"));
            hit.setStars(n.path("star_count").asInt(0));
            if (StringUtils.hasText(hit.getHtmlUrl()) && StringUtils.hasText(hit.getName())) {
                out.add(hit);
            }
        }
        return out;
    }

    private CodeRepoTreeResponse listGithubTree(ParsedRepo parsed, String branchHint, String rel) {
        String htmlUrl = "https://github.com/" + parsed.owner + "/" + parsed.name;
        GithubRef ref = resolveGithubBranch(parsed, branchHint, htmlUrl);
        String branch = ref.branch;
        htmlUrl = ref.htmlUrl;
        String cacheKey = parsed.owner + "/" + parsed.name + "@" + branch + ":" + (rel == null ? "" : rel);
        CodeRepoTreeResponse cached = githubDirCache.get(cacheKey);
        if (cached != null) {
            return cached;
        }
        CodeRepoTreeResponse out;
        String sha = githubDirSha.get(cacheKey);
        try {
            if (!StringUtils.hasText(rel)) {
                out = listGithubGitTree(parsed, branch, htmlUrl, rel, branch);
            } else if (StringUtils.hasText(sha)) {
                out = listGithubGitTree(parsed, branch, htmlUrl, rel, sha);
            } else {
                out = listGithubContents(parsed, branch, htmlUrl, rel);
            }
        } catch (RuntimeException ex) {
            log.debug("GitHub git tree fallback to contents for {} {}: {}", parsed.name, rel, ex.getMessage());
            out = listGithubContents(parsed, branch, htmlUrl, rel);
        }
        githubDirCache.put(cacheKey, out);
        return out;
    }

    private GithubRef resolveGithubBranch(ParsedRepo parsed, String branchHint, String htmlUrl) {
        String branch = firstNonBlank(branchHint, parsed.branch);
        if (StringUtils.hasText(branch)) {
            return new GithubRef(branch, htmlUrl);
        }
        JsonNode repo = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name,
                githubHeaders());
        branch = firstNonBlank(repo.path("default_branch").asText("main"));
        String fromRepo = textOrNull(repo.path("html_url"));
        return new GithubRef(branch, fromRepo != null ? fromRepo : htmlUrl);
    }

    private CodeRepoTreeResponse listGithubGitTree(
            ParsedRepo parsed, String branch, String htmlUrl, String rel, String treeRef) {
        JsonNode listing = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name
                        + "/git/trees/" + encodePath(treeRef),
                githubHeaders());
        JsonNode tree = listing.path("tree");
        if (!tree.isArray()) {
            throw new IllegalArgumentException("Not a directory");
        }
        String prefix = StringUtils.hasText(rel) ? rel.replaceAll("/+$", "") : "";
        List<CodeRepoTreeEntryDto> entries = new ArrayList<>();
        for (JsonNode n : tree) {
            String typeRaw = n.path("type").asText("");
            String name = n.path("path").asText("");
            if (!isBrowsableName(name) || name.contains("/")) {
                continue;
            }
            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            if (path.contains("..")) {
                continue;
            }
            boolean dir = "tree".equals(typeRaw);
            if (dir) {
                githubDirSha.put(parsed.owner + "/" + parsed.name + "@" + branch + ":" + path, n.path("sha").asText(""));
            }
            entries.add(new CodeRepoTreeEntryDto(name, path, dir ? "dir" : "file", n.path("size").asInt(0)));
        }
        entries.sort(browseComparator());
        if (entries.size() > 200) {
            entries = new ArrayList<>(entries.subList(0, 200));
        }
        return treeResponse("github", parsed, htmlUrl, branch, rel, entries);
    }

    private CodeRepoTreeResponse listGithubContents(ParsedRepo parsed, String branch, String htmlUrl, String rel) {
        String url = "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name + "/contents";
        if (StringUtils.hasText(rel)) {
            url += "/" + encodePath(rel).replace("%2F", "/");
        }
        url += "?ref=" + encodePath(branch);
        JsonNode listing = getJson(url, githubHeaders());
        if (!listing.isArray()) {
            throw new IllegalArgumentException("Not a directory");
        }
        List<CodeRepoTreeEntryDto> entries = new ArrayList<>();
        for (JsonNode n : listing) {
            String typeRaw = n.path("type").asText("");
            String path = n.path("path").asText("");
            String name = n.path("name").asText("");
            if (!isBrowsableName(name) || path.contains("..")) {
                continue;
            }
            String type = "dir".equals(typeRaw) ? "dir" : "file";
            entries.add(new CodeRepoTreeEntryDto(name, path, type, n.path("size").asInt(0)));
            if ("dir".equals(type)) {
                githubDirSha.put(
                        parsed.owner + "/" + parsed.name + "@" + branch + ":" + path,
                        n.path("sha").asText(""));
            }
        }
        entries.sort(browseComparator());
        if (entries.size() > 200) {
            entries = new ArrayList<>(entries.subList(0, 200));
        }
        return treeResponse("github", parsed, htmlUrl, branch, rel, entries);
    }

    private CachedFlatTree loadGithubFlatTree(ParsedRepo parsed, String branch) {
        String key = parsed.owner + "/" + parsed.name + "@" + branch;
        CachedFlatTree cached = githubTreeCache.get(key);
        long now = System.currentTimeMillis();
        if (cached != null && cached.expiresAtMillis > now) {
            return cached;
        }
        pruneGithubTreeCache(now);
        JsonNode treeDoc = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name
                        + "/git/trees/" + encodePath(branch) + "?recursive=1",
                githubHeaders());
        boolean truncated = treeDoc.path("truncated").asBoolean(false);
        List<FlatNode> nodes = new ArrayList<>();
        JsonNode tree = treeDoc.path("tree");
        if (tree.isArray()) {
            for (JsonNode n : tree) {
                String type = n.path("type").asText("");
                String path = n.path("path").asText("");
                if (!StringUtils.hasText(path) || path.contains("..")) {
                    continue;
                }
                boolean dir = "tree".equals(type);
                if (!dir && !"blob".equals(type)) {
                    continue;
                }
                nodes.add(new FlatNode(path, dir, n.path("size").asInt(0)));
            }
        }
        CachedFlatTree fresh = new CachedFlatTree(now + TREE_CACHE_MS, truncated, nodes);
        githubTreeCache.put(key, fresh);
        return fresh;
    }

    private void pruneGithubTreeCache(long now) {
        githubTreeCache.entrySet().removeIf(e -> e.getValue().expiresAtMillis <= now);
        if (githubTreeCache.size() <= 8) {
            return;
        }
        String oldest = null;
        long oldestExp = Long.MAX_VALUE;
        for (Map.Entry<String, CachedFlatTree> e : githubTreeCache.entrySet()) {
            if (e.getValue().expiresAtMillis < oldestExp) {
                oldestExp = e.getValue().expiresAtMillis;
                oldest = e.getKey();
            }
        }
        if (oldest != null) {
            githubTreeCache.remove(oldest);
        }
    }

    static List<CodeRepoTreeEntryDto> entriesAt(List<FlatNode> nodes, String rel) {
        String prefix = StringUtils.hasText(rel) ? rel.replaceAll("/+$", "") + "/" : "";
        Map<String, CodeRepoTreeEntryDto> byName = new LinkedHashMap<>();
        for (FlatNode node : nodes) {
            String path = node.path();
            if (!prefix.isEmpty() && !path.startsWith(prefix)) {
                continue;
            }
            String rest = prefix.isEmpty() ? path : path.substring(prefix.length());
            if (!StringUtils.hasText(rest)) {
                continue;
            }
            int slash = rest.indexOf('/');
            if (slash < 0) {
                if (!isBrowsableName(rest)) {
                    continue;
                }
                byName.putIfAbsent(rest, new CodeRepoTreeEntryDto(
                        rest, path, node.dir() ? "dir" : "file", node.size()));
            } else {
                String dirName = rest.substring(0, slash);
                if (!isBrowsableName(dirName)) {
                    continue;
                }
                String dirPath = prefix + dirName;
                byName.putIfAbsent(dirName, new CodeRepoTreeEntryDto(dirName, dirPath, "dir", 0));
            }
        }
        List<CodeRepoTreeEntryDto> entries = new ArrayList<>(byName.values());
        entries.sort(browseComparator());
        if (entries.size() > 200) {
            return new ArrayList<>(entries.subList(0, 200));
        }
        return entries;
    }

    private static CodeRepoTreeResponse treeResponse(
            String host,
            ParsedRepo parsed,
            String htmlUrl,
            String branch,
            String rel,
            List<CodeRepoTreeEntryDto> entries) {
        CodeRepoTreeResponse out = new CodeRepoTreeResponse();
        out.setHost(host);
        out.setOwner(parsed.owner);
        out.setName(parsed.name);
        out.setHtmlUrl(htmlUrl);
        out.setDefaultBranch(branch);
        out.setPath(rel);
        out.setEntries(entries);
        return out;
    }

    private CodeRepoTreeResponse listGitlabTree(ParsedRepo parsed, String branchHint, String rel) {
        String projectPath = encodePath(parsed.owner + "/" + parsed.name);
        String htmlUrl = "https://gitlab.com/" + parsed.owner + "/" + parsed.name;
        String branch = firstNonBlank(branchHint, parsed.branch);
        if (!StringUtils.hasText(branch)) {
            JsonNode project = getJson("https://gitlab.com/api/v4/projects/" + projectPath, gitlabHeaders());
            branch = firstNonBlank(project.path("default_branch").asText("main"));
            String fromProject = textOrNull(project.path("web_url"));
            if (fromProject != null) {
                htmlUrl = fromProject;
            }
        }
        String url = "https://gitlab.com/api/v4/projects/" + projectPath
                + "/repository/tree?per_page=100&ref=" + encodePath(branch);
        if (StringUtils.hasText(rel)) {
            url += "&path=" + encodePath(rel);
        }
        JsonNode listing = getJson(url, gitlabHeaders());
        List<CodeRepoTreeEntryDto> entries = new ArrayList<>();
        if (listing.isArray()) {
            for (JsonNode n : listing) {
                String typeRaw = n.path("type").asText("");
                String path = n.path("path").asText("");
                String name = n.path("name").asText("");
                if (!isBrowsableName(name) || path.contains("..")) {
                    continue;
                }
                String type = "tree".equals(typeRaw) ? "dir" : "file";
                entries.add(new CodeRepoTreeEntryDto(name, path, type, 0));
            }
        }
        entries.sort(browseComparator());
        return treeResponse("gitlab", parsed, htmlUrl, branch, rel, entries);
    }

    private CodeRepoFileDto readGithubFile(ParsedRepo parsed, String branchHint, String rel) {
        String branch = firstNonBlank(branchHint, parsed.branch);
        if (!StringUtils.hasText(branch)) {
            JsonNode repo = getJson(
                    "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name,
                    githubHeaders());
            branch = firstNonBlank(repo.path("default_branch").asText("main"));
        }
        JsonNode file = getJson(
                "https://api.github.com/repos/" + parsed.owner + "/" + parsed.name
                        + "/contents/" + encodePath(rel).replace("%2F", "/")
                        + "?ref=" + encodePath(branch),
                githubHeaders());
        if (!"file".equals(file.path("type").asText())) {
            throw new IllegalArgumentException("Not a file");
        }
        int size = file.path("size").asInt(0);
        if (size > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("File is too large to preview");
        }
        String content = decodeGithubBlob(file.path("content").asText(""), file.path("encoding").asText("base64"));
        if (content.length() > MAX_FILE_BYTES) {
            content = content.substring(0, MAX_FILE_BYTES);
        }
        return new CodeRepoFileDto(rel, languageOf(rel), content, content.length());
    }

    private CodeRepoFileDto readGitlabFile(ParsedRepo parsed, String branchHint, String rel) {
        String projectPath = encodePath(parsed.owner + "/" + parsed.name);
        String branch = firstNonBlank(branchHint, parsed.branch);
        if (!StringUtils.hasText(branch)) {
            JsonNode project = getJson("https://gitlab.com/api/v4/projects/" + projectPath, gitlabHeaders());
            branch = firstNonBlank(project.path("default_branch").asText("main"));
        }
        String content = getText(
                "https://gitlab.com/api/v4/projects/" + projectPath
                        + "/repository/files/" + encodePath(rel) + "/raw?ref=" + encodePath(branch),
                gitlabHeaders());
        if (content.length() > MAX_FILE_BYTES) {
            content = content.substring(0, MAX_FILE_BYTES);
        }
        return new CodeRepoFileDto(rel, languageOf(rel), content, content.length());
    }

    private static boolean isBrowsableName(String name) {
        if (!StringUtils.hasText(name) || ".".equals(name) || "..".equals(name)) {
            return false;
        }
        return !".git".equalsIgnoreCase(name);
    }

    private static Comparator<CodeRepoTreeEntryDto> browseComparator() {
        return Comparator
                .comparingInt((CodeRepoTreeEntryDto e) -> "dir".equals(e.getType()) ? 0 : 1)
                .thenComparing(e -> e.getName() == null ? "" : e.getName(), String.CASE_INSENSITIVE_ORDER);
    }

    static String sanitizeRelPath(String rawPath) {
        if (!StringUtils.hasText(rawPath) || "/".equals(rawPath.trim())) {
            return "";
        }
        String path = rawPath.trim().replace('\\', '/');
        while (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.contains("..") || path.contains(":") || path.contains("//")) {
            throw new IllegalArgumentException("Invalid path");
        }
        for (String seg : path.split("/")) {
            if (seg.isEmpty() || ".".equals(seg) || "..".equals(seg)) {
                throw new IllegalArgumentException("Invalid path");
            }
            if (!seg.matches("[A-Za-z0-9._\\-@+]+")) {
                throw new IllegalArgumentException("Invalid path");
            }
        }
        return path;
    }

    ParsedRepo parse(String rawUrl) {
        if (!StringUtils.hasText(rawUrl)) {
            throw new IllegalArgumentException("Repository URL is required");
        }
        String trimmed = rawUrl.trim();
        if (trimmed.startsWith("git@github.com:")) {
            trimmed = "https://github.com/" + trimmed.substring("git@github.com:".length());
        } else if (trimmed.startsWith("git@gitlab.com:")) {
            trimmed = "https://gitlab.com/" + trimmed.substring("git@gitlab.com:".length());
        }
        URI uri;
        try {
            uri = URI.create(trimmed);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("Invalid repository URL");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            throw new IllegalArgumentException("Only http(s) GitHub or GitLab URLs are allowed");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if ("www.github.com".equals(host)) {
            host = "github.com";
        }
        if ("www.gitlab.com".equals(host)) {
            host = "gitlab.com";
        }
        if (!"github.com".equals(host) && !"gitlab.com".equals(host)) {
            throw new IllegalArgumentException("Only github.com and gitlab.com public repositories are supported");
        }
        String path = uri.getPath() == null ? "" : uri.getPath();
        path = path.replaceAll("^/+", "").replaceAll("/+$", "");
        if (path.endsWith(".git")) {
            path = path.substring(0, path.length() - 4);
        }
        String[] parts = path.split("/");
        if (parts.length < 2 || !StringUtils.hasText(parts[0]) || !StringUtils.hasText(parts[1])) {
            throw new IllegalArgumentException("URL must look like https://github.com/owner/repo");
        }
        for (String p : parts) {
            if (!p.matches("[A-Za-z0-9._\\-]+")) {
                throw new IllegalArgumentException("Repository path contains invalid characters");
            }
        }
        String owner;
        String name;
        String branch = null;
        String kind = "github.com".equals(host) ? "github" : "gitlab";
        if ("github".equals(kind)) {
            owner = parts[0];
            name = parts[1];
            if (parts.length >= 4 && "tree".equals(parts[2])) {
                branch = parts[3];
            }
        } else {
            int treeIdx = -1;
            for (int i = 0; i < parts.length; i++) {
                if ("-".equals(parts[i]) && i + 1 < parts.length && "tree".equals(parts[i + 1])) {
                    treeIdx = i;
                    break;
                }
            }
            int end = treeIdx >= 0 ? treeIdx : parts.length;
            if (end < 2) {
                throw new IllegalArgumentException("URL must look like https://gitlab.com/group/project");
            }
            owner = String.join("/", java.util.Arrays.copyOfRange(parts, 0, end - 1));
            name = parts[end - 1];
            if (treeIdx >= 0 && treeIdx + 2 < parts.length) {
                branch = parts[treeIdx + 2];
            }
        }
        return new ParsedRepo(kind, owner, name, branch);
    }

    private CodeRepoAnalyzeResponse baseResponse(ParsedRepo parsed) {
        CodeRepoAnalyzeResponse out = new CodeRepoAnalyzeResponse();
        out.setHost(parsed.host);
        out.setOwner(parsed.owner);
        out.setName(parsed.name);
        return out;
    }

    private boolean isCandidate(String path, int size) {
        if (!StringUtils.hasText(path) || path.contains("..")) {
            return false;
        }
        String lower = path.replace('\\', '/').toLowerCase(Locale.ROOT);
        if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".map")) {
            return false;
        }
        String[] segs = lower.split("/");
        for (String s : segs) {
            if (SKIP_DIR_SEGMENTS.contains(s)) {
                return false;
            }
        }
        String lang = languageOf(path);
        if (lang == null) {
            String base = segs[segs.length - 1];
            if (!base.equals("dockerfile") && !base.equals("makefile") && !base.startsWith("readme")) {
                return false;
            }
        }
        if (size > 0 && (size > MAX_FILE_BYTES || size < 1)) {
            return false;
        }
        return true;
    }

    private static String languageOf(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        int slash = lower.lastIndexOf('/');
        String file = slash >= 0 ? lower.substring(slash + 1) : lower;
        if (file.startsWith("readme")) {
            return "markdown";
        }
        if ("dockerfile".equals(file) || file.endsWith(".dockerfile")) {
            return "dockerfile";
        }
        if ("makefile".equals(file)) {
            return "makefile";
        }
        int dot = file.lastIndexOf('.');
        if (dot < 0) {
            return null;
        }
        return EXT_LANGUAGE.get(file.substring(dot));
    }

    private static Comparator<TreeEntry> treeComparator() {
        return Comparator
                .comparingInt((TreeEntry e) -> e.path.toLowerCase(Locale.ROOT).contains("readme") ? 0 : 1)
                .thenComparing(e -> e.path, String.CASE_INSENSITIVE_ORDER);
    }

    private JsonNode getJson(String url, HttpHeaders headers) {
        try {
            ResponseEntity<String> res = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String body = res.getBody();
            if (!StringUtils.hasText(body)) {
                throw new IllegalStateException("Empty response from repository API");
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException ex) {
            throw new IllegalArgumentException(repoHttpMessage(ex));
        } catch (RestClientException ex) {
            throw new IllegalStateException("Repository API unreachable: " + ex.getMessage());
        } catch (IllegalArgumentException | IllegalStateException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new IllegalStateException("Could not read repository metadata");
        }
    }

    private String getText(String url, HttpHeaders headers) {
        try {
            ResponseEntity<String> res = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            return res.getBody() != null ? res.getBody() : "";
        } catch (HttpStatusCodeException ex) {
            throw new IllegalArgumentException(repoHttpMessage(ex));
        } catch (RestClientException ex) {
            throw new IllegalStateException("Repository API unreachable: " + ex.getMessage());
        }
    }

    private static String repoHttpMessage(HttpStatusCodeException ex) {
        int code = ex.getStatusCode().value();
        if (code == 404) {
            return "Repository not found or private";
        }
        if (code == 403 || code == 429) {
            return "Repository API rate limit reached. Try later or configure a token on the server.";
        }
        return "Repository API error HTTP " + code;
    }

    private HttpHeaders githubHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.set(HttpHeaders.ACCEPT, "application/vnd.github+json");
        h.set(HttpHeaders.USER_AGENT, "PatTool-CodeWorkbench");
        if (StringUtils.hasText(githubToken)) {
            h.set(HttpHeaders.AUTHORIZATION, "Bearer " + githubToken);
        }
        return h;
    }

    private HttpHeaders gitlabHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.set(HttpHeaders.ACCEPT, "application/json");
        h.set(HttpHeaders.USER_AGENT, "PatTool-CodeWorkbench");
        if (StringUtils.hasText(gitlabToken)) {
            h.set("PRIVATE-TOKEN", gitlabToken);
        }
        return h;
    }

    private static String decodeGithubBlob(String content, String encoding) {
        if (!StringUtils.hasText(content)) {
            return "";
        }
        if (!"base64".equalsIgnoreCase(encoding.trim())) {
            return content;
        }
        String compact = content.replaceAll("\\s", "");
        try {
            byte[] raw = Base64.getDecoder().decode(compact);
            return new String(raw, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            return "";
        }
    }

    private static String encodePath(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String v : values) {
            if (StringUtils.hasText(v)) {
                return v.trim();
            }
        }
        return null;
    }

    private static String textOrNull(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        String t = node.asText("");
        return StringUtils.hasText(t) ? t : null;
    }

    static final class ParsedRepo {
        final String host;
        final String owner;
        final String name;
        final String branch;

        ParsedRepo(String host, String owner, String name, String branch) {
            this.host = host;
            this.owner = owner;
            this.name = name;
            this.branch = branch;
        }
    }

    private static final class TreeEntry {
        final String path;
        final String sha;
        final int size;

        TreeEntry(String path, String sha, int size) {
            this.path = path;
            this.sha = sha;
            this.size = size;
        }
    }

    private record FlatNode(String path, boolean dir, int size) {}

    private record GithubRef(String branch, String htmlUrl) {}

    private static final class CachedFlatTree {
        final long expiresAtMillis;
        final boolean truncated;
        final List<FlatNode> nodes;

        CachedFlatTree(long expiresAtMillis, boolean truncated, List<FlatNode> nodes) {
            this.expiresAtMillis = expiresAtMillis;
            this.truncated = truncated;
            this.nodes = nodes;
        }
    }
}
