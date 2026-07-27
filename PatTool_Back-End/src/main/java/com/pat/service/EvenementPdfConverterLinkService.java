package com.pat.service;

import com.pat.repo.MembersRepository;
import com.pat.repo.PdfConverterDocumentRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.PdfConverterDocument;
import com.pat.repo.domain.PdfConverterDocumentLink;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Fills {@link Evenement#setLinkedPdfConverterDocuments} from {@link PdfConverterDocument}
 * rows linked by {@code evenementId}. Field is transient; attach after load from Mongo.
 */
@Service
public class EvenementPdfConverterLinkService {

    private final PdfConverterDocumentRepository pdfConverterDocumentRepository;
    private final MembersRepository membersRepository;

    public EvenementPdfConverterLinkService(
            PdfConverterDocumentRepository pdfConverterDocumentRepository,
            MembersRepository membersRepository) {
        this.pdfConverterDocumentRepository = pdfConverterDocumentRepository;
        this.membersRepository = membersRepository;
    }

    public void attachLinkedPdfDocumentsForEvents(List<Evenement> events) {
        if (events == null || events.isEmpty()) {
            return;
        }
        for (Evenement e : events) {
            if (e != null) {
                e.setLinkedPdfConverterDocuments(Collections.emptyList());
            }
        }
        List<String> eventIds = events.stream()
                .filter(e -> e != null && StringUtils.hasText(e.getId()))
                .map(Evenement::getId)
                .distinct()
                .toList();
        if (eventIds.isEmpty()) {
            return;
        }
        List<PdfConverterDocument> linked = pdfConverterDocumentRepository.findByEvenementIdIn(eventIds);
        if (linked == null || linked.isEmpty()) {
            return;
        }
        Map<String, List<PdfConverterDocumentLink>> byEvent = new HashMap<>();
        Map<String, String> ownerNameCache = new HashMap<>();
        for (PdfConverterDocument doc : linked) {
            if (doc == null || !StringUtils.hasText(doc.getEvenementId()) || !StringUtils.hasText(doc.getId())) {
                continue;
            }
            PdfConverterDocumentLink link = toLink(doc, ownerNameCache);
            byEvent.computeIfAbsent(doc.getEvenementId().trim(), k -> new ArrayList<>()).add(link);
        }
        for (List<PdfConverterDocumentLink> list : byEvent.values()) {
            list.sort(Comparator.comparing(
                    PdfConverterDocumentLink::getUpdatedAt,
                    Comparator.nullsLast(Comparator.reverseOrder())));
        }
        for (Evenement ev : events) {
            if (ev == null || !StringUtils.hasText(ev.getId())) {
                continue;
            }
            List<PdfConverterDocumentLink> docs = byEvent.get(ev.getId());
            ev.setLinkedPdfConverterDocuments(docs != null ? docs : Collections.emptyList());
        }
    }

    public void attachLinkedPdfDocuments(Evenement evenement) {
        if (evenement == null) {
            return;
        }
        evenement.setLinkedPdfConverterDocuments(Collections.emptyList());
        if (!StringUtils.hasText(evenement.getId())) {
            return;
        }
        List<PdfConverterDocument> linked =
                pdfConverterDocumentRepository.findByEvenementIdOrderByUpdatedAtDesc(evenement.getId().trim());
        if (linked == null || linked.isEmpty()) {
            return;
        }
        Map<String, String> ownerNameCache = new HashMap<>();
        List<PdfConverterDocumentLink> out = new ArrayList<>(linked.size());
        for (PdfConverterDocument doc : linked) {
            if (doc != null && StringUtils.hasText(doc.getId())) {
                out.add(toLink(doc, ownerNameCache));
            }
        }
        evenement.setLinkedPdfConverterDocuments(out);
    }

    private PdfConverterDocumentLink toLink(PdfConverterDocument doc, Map<String, String> ownerNameCache) {
        PdfConverterDocumentLink link = new PdfConverterDocumentLink();
        link.setId(doc.getId());
        link.setFileName(doc.getFileName());
        link.setOwnerMemberId(doc.getOwnerMemberId());
        link.setUpdatedAt(doc.getUpdatedAt());
        String ownerId = doc.getOwnerMemberId();
        if (StringUtils.hasText(ownerId)) {
            String cached = ownerNameCache.get(ownerId);
            if (cached == null) {
                cached = membersRepository.findById(ownerId)
                        .map(this::memberDisplayName)
                        .orElse(ownerId);
                ownerNameCache.put(ownerId, cached);
            }
            link.setOwnerDisplayName(cached);
        }
        return link;
    }

    private String memberDisplayName(Member member) {
        if (StringUtils.hasText(member.getUserName())) {
            return member.getUserName().trim();
        }
        String first = member.getFirstName() != null ? member.getFirstName().trim() : "";
        String last = member.getLastName() != null ? member.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        return StringUtils.hasText(full) ? full : member.getId();
    }
}
