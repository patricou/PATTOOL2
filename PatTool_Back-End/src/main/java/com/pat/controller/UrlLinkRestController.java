package com.pat.controller;

import com.pat.repo.domain.UrlLink;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.Member;
import com.pat.repo.UrlLinkRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.controller.dto.LinksViewDTO;
import com.pat.service.LinksViewService;
import com.pat.util.MemberReferenceIds;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api")
public class UrlLinkRestController {

    private static final Logger log = LoggerFactory.getLogger(UrlLinkRestController.class);

    @Autowired
    UrlLinkRepository urlLinkRepository;

    @Autowired
    FriendRepository friendRepository;
    
    @Autowired
    MembersRepository membersRepository;

    @Autowired
    LinksViewService linksViewService;

    @GetMapping(value="/urllink", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<UrlLink> getUrlLink(@RequestHeader(value = "user-id", required = false) String userId){
        log.debug("Get urlLink / User Id : "+ userId);
        Sort sort = Sort.by(Sort.Direction.ASC, "linkName");
        List<UrlLink> allLinks = urlLinkRepository.findAll(sort);
        hydrateUrlLinkAuthors(allLinks);
        
        // Filter links: show public ones, friends visibility ones, or those where user is author
        if (userId != null && !userId.isEmpty()) {
            // Get current user and their friends for friends visibility check
            Optional<Member> currentUserOpt = membersRepository.findById(userId);
            List<String> friendIds = java.util.Collections.emptyList();
            if (currentUserOpt.isPresent()) {
                Member currentUser = currentUserOpt.get();
                List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
                friendIds = friendships.stream()
                    .flatMap(friendship -> java.util.stream.Stream.of(
                        friendship.getUser1() != null && !friendship.getUser1().getId().equals(userId) ? friendship.getUser1().getId() : null,
                        friendship.getUser2() != null && !friendship.getUser2().getId().equals(userId) ? friendship.getUser2().getId() : null
                    ))
                    .filter(id -> id != null)
                    .collect(Collectors.toList());
            }
            
            final List<String> finalFriendIds = friendIds;
            return allLinks.stream()
                .filter(link -> {
                    // If no visibility or public, show it
                    if (link.getVisibility() == null || "public".equals(link.getVisibility())) {
                        return true;
                    }
                    // If private, only show if user is the author
                    if ("private".equals(link.getVisibility()) && link.getAuthor() != null) {
                        return userId.equals(link.getAuthor().getId());
                    }
                    // If friends visibility, show if user is author or if author is a friend
                    if ("friends".equals(link.getVisibility()) && link.getAuthor() != null) {
                        if (userId.equals(link.getAuthor().getId())) {
                            return true; // User is the author
                        }
                        return finalFriendIds.contains(link.getAuthor().getId()); // Author is a friend
                    }
                    return false;
                })
                .collect(Collectors.toList());
        }
        
        // If no user ID, return only public links
        return allLinks.stream()
            .filter(link -> link.getVisibility() == null || "public".equals(link.getVisibility()))
            .collect(Collectors.toList());
    }

    /**
     * Single endpoint for the links page: returns categories and links grouped by category
     * in one JSON response. Reduces round-trips and allows faster display.
     */
    @GetMapping(value = "/links-view", produces = MediaType.APPLICATION_JSON_VALUE)
    public LinksViewDTO getLinksView(@RequestHeader(value = "user-id", required = false) String userId) {
        log.debug("Get links-view for user: {}", userId);
        return linksViewService.buildLinksView(userId);
    }

    @GetMapping(value="/urllink/id/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<UrlLink> getUrlLinkById(@PathVariable("id") String id) {
        log.info("Get urlLink by id: {}", id);
        Optional<UrlLink> urlLink = urlLinkRepository.findById(id);
        return urlLink.map(u -> {
            hydrateUrlLinkAuthors(java.util.List.of(u));
            return ResponseEntity.ok(u);
        }).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping(value="/urllink", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<UrlLink> createUrlLink(@RequestBody UrlLink urlLink) {
        log.info("Create urlLink: {}", urlLink.getLinkName());
        try {
            // Capitalize first letter of linkName
            if (urlLink.getLinkName() != null && !urlLink.getLinkName().isEmpty()) {
                String name = urlLink.getLinkName();
                urlLink.setLinkName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of linkDescription
            if (urlLink.getLinkDescription() != null && !urlLink.getLinkDescription().isEmpty()) {
                String description = urlLink.getLinkDescription();
                urlLink.setLinkDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            // Generate next urlLinkID if needed
            if (urlLink.getUrlLinkID() == null || urlLink.getUrlLinkID().isEmpty()) {
                // Find the maximum urlLinkID and increment by 1
                List<UrlLink> allLinks = urlLinkRepository.findAll();
                long maxId = 0;
                for (UrlLink link : allLinks) {
                    try {
                        long id = Long.parseLong(link.getUrlLinkID());
                        if (id > maxId) {
                            maxId = id;
                        }
                    } catch (NumberFormatException e) {
                        // Skip invalid urlLinkID values
                    }
                }
                urlLink.setUrlLinkID(String.valueOf(maxId + 1));
            }
            // Don't set MongoDB _id manually, let MongoDB generate it
            urlLink.setId(null);
            UrlLink savedUrlLink = urlLinkRepository.save(urlLink);
            return new ResponseEntity<>(savedUrlLink, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error creating urlLink: ", e);
            return new ResponseEntity<>(null, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @PutMapping(value="/urllink/{id}")
    public ResponseEntity<UrlLink> updateUrlLink(@PathVariable String id, @RequestBody UrlLink urlLinkDetails) {
        log.info("Update urlLink with id: {}", id);
        Optional<UrlLink> urlLinkOptional = urlLinkRepository.findById(id);
        
        if (urlLinkOptional.isPresent()) {
            UrlLink urlLink = urlLinkOptional.get();
            
            // Capitalize first letter of linkName if provided
            if (urlLinkDetails.getLinkName() != null && !urlLinkDetails.getLinkName().isEmpty()) {
                String name = urlLinkDetails.getLinkName();
                urlLink.setLinkName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            urlLink.setUrl(urlLinkDetails.getUrl());
            
            // Capitalize first letter of linkDescription if provided
            if (urlLinkDetails.getLinkDescription() != null && !urlLinkDetails.getLinkDescription().isEmpty()) {
                String description = urlLinkDetails.getLinkDescription();
                urlLink.setLinkDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            urlLink.setCategoryLinkID(urlLinkDetails.getCategoryLinkID());
            urlLink.setVisibility(urlLinkDetails.getVisibility());
            urlLink.setOpenByProxyLan(urlLinkDetails.isOpenByProxyLan());
            urlLink.setAuthor(urlLinkDetails.getAuthor());
            
            UrlLink updatedUrlLink = urlLinkRepository.save(urlLink);
            return ResponseEntity.ok(updatedUrlLink);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @PutMapping(value="/visibility")
    public ResponseEntity<UrlLink> updatevisibilty(@RequestBody UrlLink urlLink) {
        log.info("Update visibility :"+ urlLink.toString());
        UrlLink urlLink1 = urlLinkRepository.save(urlLink);
        return new ResponseEntity<>(urlLink1, HttpStatus.OK);
    }

    @DeleteMapping(value="/urllink/{id}")
    public ResponseEntity<HttpStatus> deleteUrlLink(@PathVariable String id) {
        log.info("Delete urlLink with id: {}", id);
        try {
            urlLinkRepository.deleteById(id);
            return new ResponseEntity<>(HttpStatus.NO_CONTENT);
        } catch (Exception e) {
            log.error("Error deleting urlLink: ", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Spring Data may map {@link UrlLink#getAuthor()} to a hollow {@link Member} whose {@code id}
     * is a DBRef {@code toString()} and other fields null. Batch-resolve via {@link LinksViewService}
     * (same query strategy as {@code /links-view}).
     */
    private void hydrateUrlLinkAuthors(List<UrlLink> links) {
        Set<String> hexes = new LinkedHashSet<>();
        Map<UrlLink, String> linkToHex = new IdentityHashMap<>();
        for (UrlLink link : links) {
            Member a = link.getAuthor();
            if (a == null) {
                continue;
            }
            if (authorMemberHasDisplayFields(a)) {
                continue;
            }
            String rawId = a.getId();
            if (rawId == null || rawId.isBlank()) {
                continue;
            }
            String hex = MemberReferenceIds.extractMemberId(rawId);
            if (hex == null) {
                continue;
            }
            hexes.add(hex);
            linkToHex.put(link, hex);
        }
        if (hexes.isEmpty()) {
            return;
        }
        Map<String, Member> resolved = linksViewService.resolveAuthorsByIds(hexes);
        for (Map.Entry<UrlLink, String> e : linkToHex.entrySet()) {
            String key = e.getValue() == null ? "" : e.getValue().trim().toLowerCase();
            Member m = resolved.get(key);
            if (m != null && authorMemberHasDisplayFields(m)) {
                e.getKey().setAuthor(m);
            }
        }
    }

    private static boolean authorMemberHasDisplayFields(Member a) {
        return (a.getUserName() != null && !a.getUserName().isBlank())
                || (a.getFirstName() != null && !a.getFirstName().isBlank())
                || (a.getLastName() != null && !a.getLastName().isBlank())
                || (a.getAddressEmail() != null && !a.getAddressEmail().isBlank());
    }
}
