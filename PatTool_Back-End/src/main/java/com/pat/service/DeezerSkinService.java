package com.pat.service;

import org.springframework.stereotype.Service;

/**
 * Deezer cabinet style. The value is the user's shared media skin
 * ({@link MediaSkinService}), also used by TV and radio.
 */
@Service
public class DeezerSkinService {

    private final MediaSkinService mediaSkinService;

    public DeezerSkinService(MediaSkinService mediaSkinService) {
        this.mediaSkinService = mediaSkinService;
    }

    public String findForSubject(String jwtSubject) {
        return mediaSkinService.findForSubject(jwtSubject);
    }

    public String saveForSubject(String jwtSubject, String skin) {
        return mediaSkinService.saveForSubject(jwtSubject, skin);
    }
}
