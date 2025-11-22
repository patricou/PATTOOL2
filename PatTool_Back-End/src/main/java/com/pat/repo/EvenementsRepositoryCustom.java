package com.pat.repo;

import com.pat.repo.domain.Evenement;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

import java.util.List;

public interface EvenementsRepositoryCustom {

	Page<Evenement> searchByFilter(String filter, String userId, Pageable pageable);
	
	/**
	 * Search events by filter without pagination for streaming
	 * Returns all matching events sorted by date
	 */
	List<Evenement> searchByFilterStream(String filter, String userId);
}
 
