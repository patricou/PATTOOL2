package com.pat.repo;

import com.pat.repo.domain.DeezerYoutubeLink;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;
import org.springframework.stereotype.Repository;

@Repository
public interface DeezerYoutubeLinkRepository extends MongoRepository<DeezerYoutubeLink, String> {

    /** Rows that store a real YouTube id. Empty misses are not links. */
    @Query(value = "{ 'videoId': { $gt: '' } }", count = true)
    long countWithVideo();
}
