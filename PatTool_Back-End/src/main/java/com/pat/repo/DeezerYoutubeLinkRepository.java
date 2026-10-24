package com.pat.repo;

import com.pat.repo.domain.DeezerYoutubeLink;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface DeezerYoutubeLinkRepository extends MongoRepository<DeezerYoutubeLink, String> {
}
