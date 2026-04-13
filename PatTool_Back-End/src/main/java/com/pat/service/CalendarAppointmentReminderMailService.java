package com.pat.service;

import com.pat.controller.MailController;
import com.pat.controller.dto.CalendarReminderMailResult;
import com.pat.controller.dto.CalendarVisibilityRecipientDTO;
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

    /** French long date with weekday (e-mail subject, header badge, intro line). */
    private static final DateTimeFormatter REMINDER_DATE_LABEL =
            DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", Locale.FRENCH);

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
     * Public base URL of the web UI (no trailing slash). Reminder e-mails append {@code /#/calendrier} (Angular hash routing).
     * Default matches the public PatTool site; override for another host, or set to a blank value to omit links.
     */
    @Value("${app.calendar.reminder-mail.ui-base-url:https://www.patrickdeschamps.com}")
    private String reminderMailUiBaseUrl;

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
        String dateLabel = REMINDER_DATE_LABEL.format(dayStartInZone);

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
        String dateLabel = REMINDER_DATE_LABEL.format(dayStart);

        Map<String, List<CalendarAppointment>> byRecipient = new HashMap<>();
        for (String memberId : resolveRecipientMemberIds(appointment)) {
            byRecipient.computeIfAbsent(memberId, k -> new ArrayList<>()).add(appointment);
        }
        return dispatchMails(byRecipient, zone, dateLabel, "manual appointment " + appointment.getId());
    }

    /**
     * People who can see this appointment (owner + visibility), same rules as reminder e-mails.
     */
    public List<CalendarVisibilityRecipientDTO> listVisibilityRecipients(CalendarAppointment appointment) {
        Set<String> ids = resolveRecipientMemberIds(appointment);
        List<CalendarVisibilityRecipientDTO> out = new ArrayList<>();
        for (String memberId : ids) {
            Optional<Member> opt = membersRepository.findById(memberId);
            if (opt.isEmpty()) {
                continue;
            }
            Member m = opt.get();
            out.add(new CalendarVisibilityRecipientDTO(
                    memberId,
                    organizerLabel(m),
                    StringUtils.hasText(m.getAddressEmail())));
        }
        out.sort(Comparator.comparing(CalendarVisibilityRecipientDTO::getDisplayName, String.CASE_INSENSITIVE_ORDER));
        return out;
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
            String html = buildHtmlBody(member, appts, zone, dateLabel, ownerCache, calendarAgendaHref());
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

    /**
     * Deep link to the calendar view. {@code null} if {@link #reminderMailUiBaseUrl} is not set.
     */
    private String calendarAgendaHref() {
        if (!StringUtils.hasText(reminderMailUiBaseUrl)) {
            return null;
        }
        String base = reminderMailUiBaseUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "https://" + base;
        }
        return base + "/#/calendrier";
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

    private static String escapeHtmlAttr(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;").replace("\"", "&quot;").replace("'", "&#39;");
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
            String dateLabel, Map<String, Member> ownerById, String calendarHref) {
        String first = escapeHtml(recipient.getFirstName() != null ? recipient.getFirstName() : "");
        DateTimeFormatter tf = DateTimeFormatter.ofPattern("HH:mm");
        String fontStack = "'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

        StringBuilder rows = new StringBuilder();
        int rowIdx = 0;
        for (CalendarAppointment a : appts) {
            String rowBg = (rowIdx % 2 == 0) ? "#f8fafc" : "#ffffff";
            rowIdx++;
            String title = escapeHtml(a.getTitle() != null ? a.getTitle() : "—");
            String start = a.getStartDate() != null
                    ? ZonedDateTime.ofInstant(a.getStartDate().toInstant(), zone).format(tf)
                    : "?";
            String end = a.getEndDate() != null
                    ? ZonedDateTime.ofInstant(a.getEndDate().toInstant(), zone).format(tf)
                    : "?";
            String notes = a.getNotes() != null && !a.getNotes().isBlank()
                    ? "<div style=\"margin-top:8px;padding:8px 10px;background:#f1f5f9;border-radius:6px;"
                    + "font-size:13px;color:#475569;line-height:1.45;border-left:3px solid #94a3b8;\">"
                    + escapeHtml(a.getNotes().trim()) + "</div>"
                    : "";
            String oid = a.getOwnerMemberId() != null ? a.getOwnerMemberId().trim() : "";
            Member owner = ownerById.get(oid);
            String org = escapeHtml(organizerLabel(owner));

            rows.append("<tr>")
                    .append("<td style=\"padding:14px 16px;background:").append(rowBg)
                    .append(";border-bottom:1px solid #e2e8f0;vertical-align:top;width:108px;\">")
                    .append("<span style=\"display:inline-block;font-family:Consolas,'Courier New',monospace;")
                    .append("font-size:13px;font-weight:600;color:#0f172a;letter-spacing:0.02em;\">")
                    .append(start).append("</span>")
                    .append("<span style=\"color:#94a3b8;font-size:12px;\"> → </span>")
                    .append("<span style=\"display:inline-block;font-family:Consolas,'Courier New',monospace;")
                    .append("font-size:13px;font-weight:600;color:#0f172a;\">").append(end).append("</span>")
                    .append("</td>")
                    .append("<td style=\"padding:14px 16px;background:").append(rowBg)
                    .append(";border-bottom:1px solid #e2e8f0;vertical-align:top;width:140px;"
                    + "font-size:14px;color:#334155;\">")
                    .append("<span style=\"display:inline-block;padding:4px 10px;background:#e0f2fe;color:#0369a1;"
                    + "border-radius:999px;font-size:12px;font-weight:600;\">")
                    .append(org).append("</span></td>")
                    .append("<td style=\"padding:14px 16px;background:").append(rowBg)
                    .append(";border-bottom:1px solid #e2e8f0;vertical-align:top;\">")
                    .append("<div style=\"font-size:15px;font-weight:600;color:#0f172a;letter-spacing:-0.01em;\">")
                    .append(title).append("</div>")
                    .append(notes)
                    .append("</td>")
                    .append("</tr>");
        }

        String calendarLinkRow = "";
        if (StringUtils.hasText(calendarHref)) {
            String hrefRaw = calendarHref.trim();
            String hrefEsc = escapeHtmlAttr(hrefRaw);
            String hrefText = escapeHtml(hrefRaw);
            /* Placed after the list of RDV (see concat order below); compact button + direct link. */
            calendarLinkRow = "<tr><td style=\"padding:4px 28px 20px 28px;font-family:" + fontStack + ";font-size:13px;\">"
                    + "<a href=\"" + hrefEsc + "\" style=\"display:inline-block;padding:6px 14px;background:#2563eb;"
                    + "color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:12px;"
                    + "line-height:1.25;box-shadow:0 2px 8px rgba(37,99,235,0.28);\">Ouvrir l'agenda PatTool</a>"
                    + "<p style=\"margin:8px 0 0 0;font-size:11px;color:#475569;line-height:1.45;word-break:break-all;\">"
                    + "Lien direct : <a href=\"" + hrefEsc + "\" style=\"color:#1d4ed8;text-decoration:underline;\">"
                    + hrefText + "</a></p></td></tr>";
        }

        return "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"UTF-8\"/>"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/></head>"
                + "<body style=\"margin:0;padding:0;background-color:#e2e8f0;\">"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"background-color:#e2e8f0;padding:28px 14px;\">"
                + "<tr><td align=\"center\">"
                + "<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;"
                + "box-shadow:0 12px 40px rgba(15,23,42,0.12);\">"
                /* header */
                + "<tr><td style=\"background-color:#0f4c81;background-image:linear-gradient(135deg,#0c4a6e 0%,#2563eb 55%,#3b82f6 100%);"
                + "padding:26px 28px 22px 28px;\">"
                + "<div style=\"font-family:" + fontStack + ";font-size:22px;font-weight:700;color:#ffffff;"
                + "letter-spacing:-0.02em;line-height:1.2;\">PatTool</div>"
                + "<div style=\"font-family:" + fontStack + ";font-size:13px;color:rgba(255,255,255,0.9);"
                + "margin-top:6px;font-weight:500;\">Rappel · Agenda personnel</div>"
                + "<div style=\"margin-top:14px;display:inline-block;padding:6px 14px;background:rgba(255,255,255,0.15);"
                + "border-radius:8px;font-family:" + fontStack + ";font-size:13px;color:#ffffff;font-weight:600;\">"
                + escapeHtml(dateLabel) + "</div>"
                + "</td></tr>"
                /* body copy */
                + "<tr><td style=\"padding:26px 28px 8px 28px;font-family:" + fontStack + ";font-size:15px;"
                + "color:#334155;line-height:1.55;\">"
                + "<p style=\"margin:0 0 12px 0;\">Bonjour" + (first.isEmpty() ? "" : " <strong style=\"color:#0f172a;\">" + first + "</strong>") + ",</p>"
                + "<p style=\"margin:0;color:#64748b;font-size:14px;\">Voici les rendez-vous prévus le <strong "
                + "style=\"color:#0f172a;\">" + escapeHtml(dateLabel) + "</strong> pour lesquels vous êtes concerné "
                + "<span style=\"color:#94a3b8;\">(</span>créateur ou visibilité<span style=\"color:#94a3b8;\">)</span> :</p>"
                + "</td></tr>"
                /* table block */
                + "<tr><td style=\"padding:8px 16px 8px 16px;\">"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"border-collapse:separate;border-spacing:0;border:1px solid #e2e8f0;border-radius:10px;"
                + "overflow:hidden;\">"
                + "<thead><tr style=\"background:linear-gradient(180deg,#1e293b 0%,#0f172a 100%);\">"
                + "<th style=\"padding:12px 16px;text-align:left;font-family:" + fontStack + ";font-size:11px;"
                + "font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.08em;\">Heure</th>"
                + "<th style=\"padding:12px 16px;text-align:left;font-family:" + fontStack + ";font-size:11px;"
                + "font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.08em;\">Organisateur</th>"
                + "<th style=\"padding:12px 16px;text-align:left;font-family:" + fontStack + ";font-size:11px;"
                + "font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.08em;\">Titre</th>"
                + "</tr></thead><tbody>"
                + rows
                + "</tbody></table>"
                + "</td></tr>"
                + calendarLinkRow
                /* footer */
                + "<tr><td style=\"padding:0 28px 24px 28px;font-family:" + fontStack + ";font-size:12px;color:#94a3b8;"
                + "border-top:1px solid #f1f5f9;\">"
                + "<p style=\"margin:16px 0 0 0;line-height:1.5;\">Message automatique envoyé par <strong "
                + "style=\"color:#64748b;\">PatTool</strong> — module agenda.</p>"
                + "</td></tr>"
                + "</table>"
                + "</td></tr></table>"
                + "</body></html>";
    }
}
