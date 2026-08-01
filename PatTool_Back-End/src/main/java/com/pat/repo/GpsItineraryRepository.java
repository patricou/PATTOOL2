package com.pat.repo;

import com.pat.repo.domain.GpsItinerary;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface GpsItineraryRepository extends MongoRepository<GpsItinerary, String> {

    List<GpsItinerary> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    List<GpsItinerary> findBySharedWithMemberIdsContainingOrderByUpdatedAtDesc(String memberId);
}
