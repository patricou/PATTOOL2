package com.pat.repo;

import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.Member;
import org.bson.types.ObjectId;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

@Repository
public class EvenementsRepositoryImpl implements EvenementsRepositoryCustom {

	private final MongoTemplate mongoTemplate;
	
	@Autowired
	private FriendRepository friendRepository;
	
	@Autowired
	private MembersRepository membersRepository;

	private static final Map<String, String> TYPE_ALIAS_LOOKUP = new HashMap<>();
	private static final Map<String, List<String>> TYPE_KEYWORDS = buildTypeKeywords();

	@Autowired
	public EvenementsRepositoryImpl(MongoTemplate mongoTemplate) {
		this.mongoTemplate = mongoTemplate;
	}

	@Override
	public Page<Evenement> searchByFilter(String filter, String userId, Pageable pageable) {
		String normalizedFilter = normalizeFilter(filter);

		Query query = new Query();
		query.addCriteria(buildAccessCriteria(userId));
		
		// PERFORMANCE OPTIMIZATION: Exclude fileUploadeds from query results
		// All files will be loaded on-demand via /api/even/{id}/files endpoint
		// This dramatically reduces document size for events with many files
		query.fields().exclude("fileUploadeds");

		List<Evenement> events = mongoTemplate.find(query, Evenement.class);

		if (events.isEmpty()) {
			return Page.empty(pageable);
		}

		if (!normalizedFilter.isEmpty()) {
			events = events.stream()
					.filter(event -> matchesFilter(event, normalizedFilter))
					.collect(Collectors.toList());

			if (events.isEmpty()) {
				return Page.empty(pageable);
			}
		}

		List<EvenementScore> scoredEvents = scoreEvents(events, normalizedFilter);
		scoredEvents.sort(Comparator
				.comparing(EvenementScore::getBeginEventDate, Comparator.nullsLast(Comparator.reverseOrder()))
				.thenComparing(EvenementScore::getScore, Comparator.reverseOrder())
				.thenComparing(e -> e.getEvenement().getEvenementName(), Comparator.nullsLast(String::compareToIgnoreCase)));

		List<Evenement> sortedEvents = new ArrayList<>(scoredEvents.size());
		for (EvenementScore scoredEvent : scoredEvents) {
			sortedEvents.add(scoredEvent.getEvenement());
		}

		return toPage(sortedEvents, pageable);
	}

	@Override
	public List<Evenement> searchByFilterStream(String filter, String userId) {
		String normalizedFilter = normalizeFilter(filter);

		Query query = new Query();
		query.addCriteria(buildAccessCriteria(userId));
		
		// PERFORMANCE OPTIMIZATION: Exclude fileUploadeds from query results
		// All files will be loaded on-demand via /api/even/{id}/files endpoint
		// This dramatically reduces document size for events with many files
		query.fields().exclude("fileUploadeds");

		List<Evenement> events = mongoTemplate.find(query, Evenement.class);

		if (events.isEmpty()) {
			return new ArrayList<>();
		}

		if (!normalizedFilter.isEmpty()) {
			events = events.stream()
					.filter(event -> matchesFilter(event, normalizedFilter))
					.collect(Collectors.toList());

			if (events.isEmpty()) {
				return new ArrayList<>();
			}
		}

		List<EvenementScore> scoredEvents = scoreEvents(events, normalizedFilter);
		scoredEvents.sort(Comparator
				.comparing(EvenementScore::getBeginEventDate, Comparator.nullsLast(Comparator.reverseOrder()))
				.thenComparing(EvenementScore::getScore, Comparator.reverseOrder())
				.thenComparing(e -> e.getEvenement().getEvenementName(), Comparator.nullsLast(String::compareToIgnoreCase)));

		List<Evenement> sortedEvents = new ArrayList<>(scoredEvents.size());
		for (EvenementScore scoredEvent : scoredEvents) {
			sortedEvents.add(scoredEvent.getEvenement());
		}

		return sortedEvents;
	}

	private Criteria buildAccessCriteria(String userId) {
		List<Criteria> accessCriteria = new ArrayList<>();
		accessCriteria.add(Criteria.where("visibility").is("public"));

		if (StringUtils.hasText(userId)) {
			accessCriteria.add(buildAuthorCriteria(userId));
			// Add friends visibility criteria
			Criteria friendsCriteria = buildFriendsVisibilityCriteria(userId);
			if (friendsCriteria != null) {
				accessCriteria.add(friendsCriteria);
			}
		}

		if (accessCriteria.size() == 1) {
			return accessCriteria.get(0);
		}

		return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
	}
	
	private Criteria buildFriendsVisibilityCriteria(String userId) {
		try {
			// Get current user
			Member currentUser = membersRepository.findById(userId).orElse(null);
			if (currentUser == null) {
				return null;
			}
			
			// Get all friends of current user
			List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
			if (friendships.isEmpty()) {
				// No friends, so no friends visibility events should be shown
				return null;
			}
			
			// Collect all friend IDs (both user1 and user2 from friendships)
			List<String> friendIds = new ArrayList<>();
			for (Friend friendship : friendships) {
				if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(userId)) {
					friendIds.add(friendship.getUser1().getId());
				}
				if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(userId)) {
					friendIds.add(friendship.getUser2().getId());
				}
			}
			
			if (friendIds.isEmpty()) {
				return null;
			}
			
			// Build criteria: visibility="friends" AND author is in friend list
			List<Criteria> friendAuthorCriteria = new ArrayList<>();
			for (String friendId : friendIds) {
				try {
					friendAuthorCriteria.add(Criteria.where("author.$id").is(new ObjectId(friendId)));
				} catch (IllegalArgumentException ex) {
					// Not an ObjectId, use string comparison
					friendAuthorCriteria.add(Criteria.where("author.id").is(friendId));
				}
			}
			
			if (friendAuthorCriteria.isEmpty()) {
				return null;
			}
			
			Criteria authorInFriends = new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0]));
			return new Criteria().andOperator(
				Criteria.where("visibility").is("friends"),
				authorInFriends
			);
		} catch (Exception e) {
			// If any error occurs, return null (don't include friends visibility)
			return null;
		}
	}

	private Criteria buildAuthorCriteria(String userId) {
		List<Criteria> authorCriteria = new ArrayList<>();
		try {
			authorCriteria.add(Criteria.where("author.$id").is(new ObjectId(userId)));
		} catch (IllegalArgumentException ex) {
			// not an ObjectId, fall back to string comparison
		}
		authorCriteria.add(Criteria.where("author.id").is(userId));
		return new Criteria().orOperator(authorCriteria.toArray(new Criteria[0]));
	}

	private String normalizeFilter(String filter) {
		if (!StringUtils.hasText(filter) || "*".equals(filter.trim())) {
			return "";
		}
		return normalizeForSearch(filter.trim());
	}

	private boolean matchesFilter(Evenement event, String normalizedFilter) {
		return matchesType(event.getType(), normalizedFilter)
				|| containsNormalized(event.getEvenementName(), normalizedFilter)
				|| containsNormalized(event.getComments(), normalizedFilter);
	}

	private boolean matchesType(String type, String normalizedFilter) {
		if (!StringUtils.hasText(type) || normalizedFilter.isEmpty()) {
			return false;
		}

		String normalizedTypeValue = normalizeForSearch(type);
		if (!normalizedTypeValue.isEmpty()) {
			if (normalizedTypeValue.contains(normalizedFilter) || normalizedFilter.contains(normalizedTypeValue)) {
				return true;
			}
		}

		String canonicalType = resolveCanonicalType(type);
		if (canonicalType == null) {
			return false;
		}

		String canonicalFilter = resolveCanonicalType(normalizedFilter);
		if (canonicalFilter != null && canonicalType.equals(canonicalFilter)) {
			return true;
		}

		List<String> keywords = TYPE_KEYWORDS.get(canonicalType);
		if (keywords == null || keywords.isEmpty()) {
			return false;
		}

		for (String keyword : keywords) {
			if (keyword.contains(normalizedFilter) || normalizedFilter.contains(keyword)) {
				return true;
			}
		}

		return false;
	}

	private List<EvenementScore> scoreEvents(List<Evenement> events, String normalizedFilter) {
		List<EvenementScore> results = new ArrayList<>(events.size());

		for (Evenement event : events) {
			int score = 0;
			if (!normalizedFilter.isEmpty()) {
				if (matchesType(event.getType(), normalizedFilter)) {
					score += 400;
				}
				if (containsNormalized(event.getEvenementName(), normalizedFilter)) {
					score += 200;
				}
				if (containsNormalized(event.getComments(), normalizedFilter)) {
					score += 100;
				}
			}
			results.add(new EvenementScore(event, score));
		}
		return results;
	}

	private boolean containsNormalized(String value, String needle) {
		if (value == null || needle.isEmpty()) {
			return false;
		}
		String normalizedValue = normalizeForSearch(value);
		return normalizedValue.contains(needle);
	}

	private Page<Evenement> toPage(List<Evenement> events, Pageable pageable) {
		int total = events.size();
		int start = (int) pageable.getOffset();
		if (start >= total) {
			return new PageImpl<>(List.of(), pageable, total);
		}
		int end = Math.min(start + pageable.getPageSize(), total);
		List<Evenement> pageContent = events.subList(start, end);
		return new PageImpl<>(pageContent, pageable, total);
	}

	private static String normalizeForSearch(String value) {
		if (!StringUtils.hasText(value)) {
			return "";
		}
		String lower = value.toLowerCase(Locale.ROOT);
		String normalized = Normalizer.normalize(lower, Normalizer.Form.NFD);
		return normalized.replaceAll("\\p{M}", "");
	}

	private static Map<String, List<String>> buildTypeKeywords() {
		TYPE_ALIAS_LOOKUP.clear();
		Map<String, List<String>> map = new HashMap<>();

		registerType(map, "1", new String[]{"vtt", "mountain bike", "mountain biking", "mtb", "bicicleta de montana", "bicicleta de montaña", "bicicletta da montagna", "btt", "mountainbike", "горный велосипед", "山地车"},
				"1", "VTT", "EVENTCREATION.TYPE.VTT");
		registerType(map, "2", new String[]{"ski", "skiing", "esqui", "esquiar", "sci", "sci alpino", "sciare", "skifahren", "lyzhi", "лыжи", "катание на лыжах", "горные лыжи", "スキー", "スキ", "스키", "滑雪"},
				"2", "SKI", "EVENTCREATION.TYPE.SKI");
		registerType(map, "3", new String[]{"run", "running", "course", "course a pied", "jogging", "footing", "correr", "carrera", "corrida", "correre", "laufen", "lauf", "rennen", "marathon", "race", "бег", "бегать"},
				"3", "RUN", "COURSE", "EVENTCREATION.TYPE.RUN");
		registerType(map, "4", new String[]{"walk", "walking", "marche", "promenade", "balade", "andar", "caminar", "paseo", "passeggiata", "spaziergang", "wandern", "步行", "散歩"},
				"4", "WALK", "MARCHE", "EVENTCREATION.TYPE.WALK");
		registerType(map, "5", new String[]{"bike", "biking", "velo", "vélo", "cycling", "cyclisme", "bicycle", "bicicleta", "bicicletta", "radfahren", "fahrrad", "自転車", "骑行"},
				"5", "BIKE", "VELO", "VÉLO", "EVENTCREATION.TYPE.BIKE");
		registerType(map, "6", new String[]{"party", "fete", "fête", "fiesta", "soirée", "celebration", "fest", "festen", "festivity", "festlichkeit", "celebracion", "celebración"},
				"6", "PARTY", "FETE", "FÊTE", "EVENTCREATION.TYPE.PARTY");
		registerType(map, "7", new String[]{"vacation", "vacances", "vacaciones", "vacanza", "urlaub", "holiday", "holidays", "ferie", "ferias", "праздники"},
				"7", "VACATION", "VACANCES", "EVENTCREATION.TYPE.VACATION");
		registerType(map, "8", new String[]{"travel", "voyage", "viaje", "viaggio", "reise", "trip", "journey", "viajar", "traveling", "travelling", "旅行", "旅"},
				"8", "TRAVEL", "VOYAGE", "EVENTCREATION.TYPE.TRAVEL");
		registerType(map, "9", new String[]{"rando", "randonnée", "randonnee", "hike", "hiking", "trek", "trekking", "senderismo", "excursion", "escursionismo", "wanderung", "wandern", "徒步", "ハイキング"},
				"9", "RANDO", "EVENTCREATION.TYPE.RANDO");
		registerType(map, "10", new String[]{"photos", "photo", "picture", "pictures", "imagenes", "immagini", "bilder", "fotografie", "fotos", "photoes", "写真", "照片"},
				"10", "PHOTOS", "EVENTCREATION.TYPE.PHOTOS");
		registerType(map, "11", new String[]{"documents", "document", "docs", "documentos", "documenti", "dokumente", "documentacion", "documentación", "documentation", "资料"},
				"11", "DOCUMENTS", "EVENTCREATION.TYPE.DOCUMENTS");
		registerType(map, "12", new String[]{"fiche", "sheet", "fact sheet", "datasheet", "scheda", "hoja", "blatt", "schede", "ficha", "schede informative"},
				"12", "FICHE", "EVENTCREATION.TYPE.FICHE");
		registerType(map, "13", new String[]{"wine", "vin", "vino", "wein", "vino", "wijn", "вино", "ワイン", "葡萄酒", "יין", "κρασί", "نبيذ"},
				"13", "WINE", "VIN", "EVENTCREATION.TYPE.WINE");
		registerType(map, "14", new String[]{"other", "autre", "otro", "altro", "andere", "其他", "その他", "أخرى", "אחר", "अन्य", "Другое", "Άλλο"},
				"14", "OTHER", "AUTRE", "EVENTCREATION.TYPE.OTHER");
		registerType(map, "15", new String[]{"visit", "visite", "visita", "besuch", "访问", "訪問", "زيارة", "ביקור", "यात्रा", "Визит", "Επίσκεψη"},
				"15", "VISIT", "VISITE", "EVENTCREATION.TYPE.VISIT");
		registerType(map, "16", new String[]{"work", "travaux", "trabajos", "lavori", "arbeiten", "工作", "作業", "أعمال", "עבודה", "काम", "Работы", "Εργασίες"},
				"16", "WORK", "TRAVAUX", "EVENTCREATION.TYPE.WORK");
		registerType(map, "17", new String[]{"family", "famille", "familia", "famiglia", "familie", "家庭", "家族", "عائلة", "משפחה", "परिवार", "Семья", "Οικογένεια"},
				"17", "FAMILY", "FAMILLE", "EVENTCREATION.TYPE.FAMILY");

		return map;
	}

	private static void registerType(Map<String, List<String>> map, String canonicalKey, String[] keywords, String... aliases) {
		List<String> normalizedKeywords = new ArrayList<>();

		registerAlias(canonicalKey, canonicalKey);
		for (String alias : aliases) {
			registerAlias(alias, canonicalKey);
		}

		for (String keyword : keywords) {
			if (!StringUtils.hasText(keyword)) {
				continue;
			}
			registerAlias(keyword, canonicalKey);
			String normalized = normalizeForSearch(keyword);
			if (!normalized.isEmpty()) {
				normalizedKeywords.add(normalized);
				registerAlias(normalized, canonicalKey);
			}
		}

		map.put(canonicalKey, normalizedKeywords);
	}

	private static void registerAlias(String alias, String canonicalKey) {
		if (!StringUtils.hasText(alias)) {
			return;
		}
		TYPE_ALIAS_LOOKUP.putIfAbsent(alias, canonicalKey);
		TYPE_ALIAS_LOOKUP.putIfAbsent(alias.toUpperCase(Locale.ROOT), canonicalKey);
		TYPE_ALIAS_LOOKUP.putIfAbsent(alias.toLowerCase(Locale.ROOT), canonicalKey);
		String normalized = normalizeForSearch(alias);
		if (!normalized.isEmpty()) {
			TYPE_ALIAS_LOOKUP.putIfAbsent(normalized, canonicalKey);
		}
	}

	private String resolveCanonicalType(String value) {
		if (!StringUtils.hasText(value)) {
			return null;
		}

		String trimmed = value.trim();

		String canonical = TYPE_ALIAS_LOOKUP.get(trimmed);
		if (canonical != null) {
			return canonical;
		}

		canonical = TYPE_ALIAS_LOOKUP.get(trimmed.toUpperCase(Locale.ROOT));
		if (canonical != null) {
			return canonical;
		}

		canonical = TYPE_ALIAS_LOOKUP.get(trimmed.toLowerCase(Locale.ROOT));
		if (canonical != null) {
			return canonical;
		}

		String normalized = normalizeForSearch(trimmed);
		return TYPE_ALIAS_LOOKUP.get(normalized);
	}

	private static class EvenementScore {
		private final Evenement evenement;
		private final int score;

		private EvenementScore(Evenement evenement, int score) {
			this.evenement = evenement;
			this.score = score;
		}

		public Evenement getEvenement() {
			return evenement;
		}

		public int getScore() {
			return score;
		}

		public Date getBeginEventDate() {
			return evenement.getBeginEventDate();
		}
	}
}

