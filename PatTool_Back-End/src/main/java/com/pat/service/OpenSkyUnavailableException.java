package com.pat.service;

/** OpenSky Network unreachable or rate-limited (distinct from flight not found). */
public class OpenSkyUnavailableException extends RuntimeException {

    public OpenSkyUnavailableException() {
        super("OpenSky Network unavailable");
    }
}
