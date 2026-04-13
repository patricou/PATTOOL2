package com.pat.service;

import com.pat.controller.MailController;
import com.pat.controller.dto.CalendarReminderMailResult;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.CalendarAppointment;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Builds and sends the same HTML reminder e-mails as the morning scheduler (per recipient,
 * digest of appointments + visibility rules).
 */
@Service
public class CalendarAppointmentReminderMailService {

    private static final Logger log = LoggerFactory.getLogger(CalendarAppointmentReminderMailService.class);

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendRepository friendRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    @Autowired
    private MailController mailController;

    @Value("${app.calendar.morning-reminder.zone:Europe/Paris}")
    private String zoneId;

    /**
     * One e-mail per recipient for all appointments overlapping a given calendar day
     * (used by {@link com.pat.service.CalendarMorningReminderScheduler}).
     */
    public CalendarReminderMailResult sendDigestsForAppointmentsOnCalendarDay(
            List<CalendarAppointment> appointmentsOnDay,
            ZonedDateTime dayStartInZone) {
        if (appointmentsOnDay == null || appointmentsOnDay.isEmpty()) {
            return new CalendarReminderMailResult(0, 0);
        }
        ZoneId zone = dayStartInZone.getZone();
        String dateLabel = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.FRENCH).format(dayStartInZone);

        Map<String, List<CalendarAppointment>> byRecipient = new HashMap<>();
        for (CalendarAppointment a : appointmentsOnDay) {
            for (String memberId : resolveRecipientMemberIds(a)) {
                byRecipient.computeIfAbsent(memberId, k -> new ArrayList<>()).add(a);
            }
        }
        return dispatchMails(byRecipient, zone, dateLabel, "scheduled digest");
    }

    /**
     * Same e-mail template as the scheduler, for one appointment (owner + visibility recipients).
     * Date line uses the appointment start date in {@link #zoneId}.
     */
    public CalendarReminderMailResult sendReminderForAppointment(CalendarAppointment appointment) {
        if (appointment == null || appointment.getStartDate() == null) {
            return new CalendarReminderMailResult(0, 0);
        }
        ZoneId zone = parseZone(zoneId);
        ZonedDateTime dayStart = appointment.getStartDate().toInstant()
                .atZone(zone)
                .toLocalDate()
                .atStartOfDay(zone);
        String dateLabel = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.FRENCH).format(dayStart);

        Map<String, List<CalendarAppointment>> byRecipient = new HashMap<>();
        for (String memberId : resolveRecipientMemberIds(appointment)) {
            byRecipient.computeIfAbsent(memberId, k -> new ArrayList<>()).add(appointment);
        }
        return dispatchMails(byRecipient, zone, dateLabel, "manual appointment " + appointment.getId());
    }

    private CalendarReminderMailResult dispatchMails(
            Map<String, List<CalendarAppointment>> byRecipient,
            ZoneId zone,
            String dateLabel,
            String logContext) {
        int sent = 0;
        int skippedNoEmail = 0;

        for (Map.Entry<String, List<CalendarAppointment>> e : byRecipient.entrySet()) {
            String memberId = e.getKey();
            List<CalendarAppointment> appts = dedupeByAppointmentId(e.getValue());
            appts.sort(Comparator.comparing(CalendarAppointment::getStartDate, Comparator.nullsLast(Date::compareTo)));

            Optional<Member> memberOpt = membersRepository.findById(memberId);
            if (memberOpt.isEmpty()) {
                log.debug("Calendar reminder ({}): no member for id={}, skipping", logContext, memberId);
                continue;
            }
            Member member = memberOpt.get();
            String email = member.getAddressEmail();
            if (!StringUtils.hasText(email)) {
                skippedNoEmail++;
                log.debug("Calendar reminder ({}): member {} has no e-mail, skipping", logContext, memberId);
                continue;
            }

            String subject = "PatTool — Rendez-vous du " + dateLabel;
            Map<String, Member> ownerCache = loadOwnersFor(appts);
            String html = buildHtmlBody(member, appts, zone, dateLabel, ownerCache);
            mailController.sendMailToRecipient(email.trim(), subject, html, true);
            sent++;
        }
        return new CalendarReminderMailResult(sent, skippedNoEmail);
    }

    /**
     * Owner plus people who would see this row in the agenda (same rules as calendar sharing).
     * Public visibility does not add all site members (only the owner receives the digest).
     */
    public Set<String> resolveRecipientMemberIds(CalendarAppointment a) {
        Set<String> ids = new HashSet<>();
        String ownerId = a.getOwnerMemberId();
        if (StringUtils.hasText(ownerId)) {
            ids.add(ownerId.trim());
        }
        String vis = a.getVisibility();
        if (!StringUtils.hasText(vis) || "private".equals(vis)) {
            return ids;
        }
        if ("public".equals(vis)) {
            return ids;
        }
        if ("friends".equals(vis) && StringUtils.hasText(ownerId)) {
            ids.addAll(friendIdsOf(ownerId.trim()));
            return ids;
        }
        if ("friendGroups".equals(vis)) {
            if (a.getFriendGroupIds() != null) {
                for (String gid : a.getFriendGroupIds()) {
                    if (StringUtils.hasText(gid)) {
                        ids.addAll(memberIdsWithAccessToFriendGroup(gid.trim()));
                    }
                }
            }
            if (StringUtils.hasText(a.getFriendGroupId())) {
                ids.addAll(memberIdsWithAccessToFriendGroup(a.getFriendGroupId().trim()));
            }
            return ids;
        }
        if (StringUtils.hasText(a.getFriendGroupId())) {
            ids.addAll(memberIdsWithAccessToFriendGroup(a.getFriendGroupId().trim()));
            return ids;
        }
        if (StringUtils.hasText(vis)) {
            List<FriendGroup> named = friendGroupRepository.findByName(vis.trim());
            for (FriendGroup g : named) {
                if (g != null && StringUtils.hasText(g.getId())) {
                    ids.addAll(memberIdsWithAccessToFriendGroup(g.getId()));
                }
            }
        }
        return ids;
    }

    private Set<String> friendIdsOf(String ownerMemberId) {
        Set<String> out = new HashSet<>();
        Optional<Member> ownerOpt = membersRepository.findById(ownerMemberId);
        if (ownerOpt.isEmpty()) {
            return out;
        }
        Member owner = ownerOpt.get();
        List<Friend> friendships = friendRepository.findByUser1OrUser2(owner, owner);
        for (Friend f : friendships) {
            if (f.getUser1() != null && StringUtils.hasText(f.getUser1().getId())
                    && !f.getUser1().getId().equals(ownerMemberId)) {
                out.add(f.getUser1().getId());
            }
            if (f.getUser2() != null && StringUtils.hasText(f.getUser2().getId())
                    && !f.getUser2().getId().equals(ownerMemberId)) {
                out.add(f.getUser2().getId());
            }
        }
        return out;
    }

    private Set<String> memberIdsWithAccessToFriendGroup(String groupId) {
        Set<String> out = new HashSet<>();
        Optional<FriendGroup> opt = friendGroupRepository.findById(groupId);
        if (opt.isEmpty()) {
            return out;
        }
        FriendGroup g = opt.get();
        if (g.getOwner() != null && StringUtils.hasText(g.getOwner().getId())) {
            out.add(g.getOwner().getId());
        }
        if (g.getMembers() != null) {
            for (Member m : g.getMembers()) {
                if (m != null && StringUtils.hasText(m.getId())) {
                    out.add(m.getId());
                }
            }
        }
        if (g.getAuthorizedUsers() != null) {
            for (Member m : g.getAuthorizedUsers()) {
                if (m != null && StringUtils.hasText(m.getId())) {
                    out.add(m.getId());
                }
            }
        }
        return out;
    }

    private static List<CalendarAppointment> dedupeByAppointmentId(List<CalendarAppointment> in) {
        Map<String, CalendarAppointment> map = new LinkedHashMap<>();
        for (CalendarAppointment a : in) {
            if (a == null) {
                continue;
            }
            String key = StringUtils.hasText(a.getId()) ? a.getId() : ("noid-" + System.identityHashCode(a));
            map.putIfAbsent(key, a);
        }
        return new ArrayList<>(map.values());
    }

    private Map<String, Member> loadOwnersFor(List<CalendarAppointment> appts) {
        Map<String, Member> owners = new HashMap<>();
        for (CalendarAppointment a : appts) {
            String oid = a.getOwnerMemberId();
            if (!StringUtils.hasText(oid) || owners.containsKey(oid)) {
                continue;
            }
            membersRepository.findById(oid.trim()).ifPresent(m -> owners.put(oid.trim(), m));
        }
        return owners;
    }

    public static ZoneId parseZone(String id) {
        if (!StringUtils.hasText(id)) {
            return ZoneId.of("Europe/Paris");
        }
        try {
            return ZoneId.of(id.trim());
        } catch (Exception ex) {
            return ZoneId.of("Europe/Paris");
        }
    }

    private static String escapeHtml(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    private static String organizerLabel(Member owner) {
        if (owner == null) {
            return "—";
        }
        String fn = owner.getFirstName() != null ? owner.getFirstName() : "";
        String ln = owner.getLastName() != null ? owner.getLastName() : "";
        String full = (fn + " " + ln).trim();
        if (!full.isEmpty()) {
            return full;
        }
        if (StringUtils.hasText(owner.getUserName())) {
            return owner.getUserName().trim();
        }
        return "—";
    }

    private static String buildHtmlBody(Member recipient, List<CalendarAppointment> appts, ZoneId zone,
            String dateLabel, Map<String, Member> ownerById) {
        String first = escapeHtml(recipient.getFirstName() != null ? recipient.getFirstName() : "");
        DateTimeFormatter tf = DateTimeFormatter.ofPattern("HH:mm");

        StringBuilder rows = new StringBuilder();
        for (CalendarAppointment a : appts) {
            String title = escapeHtml(a.getTitle() != null ? a.getTitle() : "—");
            String start = a.getStartDate() != null
                    ? ZonedDateTime.ofInstant(a.getStartDate().toInstant(), zone).format(tf)
                    : "?";
            String end = a.getEndDate() != null
                    ? ZonedDateTime.ofInstant(a.getEndDate().toInstant(), zone).format(tf)
                    : "?";
            String notes = a.getNotes() != null && !a.getNotes().isBlank()
                    ? "<br/><span style=\"color:#555;font-size:12px;\">" + escapeHtml(a.getNotes().trim()) + "</span>"
                    : "";
            String oid = a.getOwnerMemberId() != null ? a.getOwnerMemberId().trim() : "";
            Member owner = ownerById.get(oid);
            String org = escapeHtml(organizerLabel(owner));

            rows.append("<tr>")
                    .append("<td style=\"padding:8px;border:1px solid #ddd;white-space:nowrap;\">")
                    .append(start).append(" – ").append(end)
                    .append("</td>")
                    .append("<td style=\"padding:8px;border:1px solid #ddd;\">").append(org).append("</td>")
                    .append("<td style=\"padding:8px;border:1px solid #ddd;\"><strong>")
                    .append(title).append("</strong>").append(notes).append("</td>")
                    .append("</tr>");
        }

        return "<html><body style=\"font-family:Arial,sans-serif;font-size:14px;color:#222;\">"
                + "<p>Bonjour" + (first.isEmpty() ? "" : " " + first) + ",</p>"
                + "<p>Voici les rendez-vous prévus le <strong>"
                + escapeHtml(dateLabel)
                + "</strong> pour lesquels vous êtes concerné (créateur ou personne avec visibilité) :</p>"
                + "<table style=\"border-collapse:collapse;width:100%;max-width:720px;\">"
                + "<thead><tr style=\"background:#f5f5f5;\">"
                + "<th style=\"padding:8px;border:1px solid #ddd;text-align:left;\">Heure</th>"
                + "<th style=\"padding:8px;border:1px solid #ddd;text-align:left;\">Organisateur</th>"
                + "<th style=\"padding:8px;border:1px solid #ddd;text-align:left;\">Titre</th>"
                + "</tr></thead><tbody>"
                + rows
                + "</tbody></table>"
                + "<p style=\"margin-top:16px;color:#666;font-size:12px;\">Message automatique — agenda PatTool.</p>"
                + "</body></html>";
    }
}
