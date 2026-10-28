package com.pat.service;

import org.springframework.stereotype.Service;

/**
 * TV cabinet style. The value is the user's shared media skin
 * ({@link MediaSkinService}), also used by radio and Deezer.
 */
@Service
public class TvSkinService {

    private final MediaSkinService mediaSkinService;

    public TvSkinService(MediaSkinService mediaSkinService) {
        this.mediaSkinService = mediaSkinService;
    }

    public String findForSubject(String jwtSubject) {
        return mediaSkinService.findForSubject(jwtSubject);
    }

    public String saveForSubject(String jwtSubject, String skin) {
        return mediaSkinService.saveForSubject(jwtSubject, skin);
    }
}
