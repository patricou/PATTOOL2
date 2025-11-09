package com.pat.repo;

import com.pat.repo.domain.Evenement;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

public interface EvenementsRepositoryCustom {

	Page<Evenement> searchByFilter(String filter, String userId, Pageable pageable);
}
 
