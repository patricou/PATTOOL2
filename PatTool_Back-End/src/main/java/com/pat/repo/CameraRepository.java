package com.pat.repo;

import com.pat.repo.domain.Camera;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface CameraRepository extends MongoRepository<Camera, String> {

    List<Camera> findByOwner(String owner);

    List<Camera> findByRoom(String room);

    List<Camera> findByPlace(String place);

    Optional<Camera> findByUid(String uid);
}
