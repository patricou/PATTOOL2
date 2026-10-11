package com.pat.service;

/**
 * Échec d'un appel à l'API NASA, ramené à un code stable pour le front.
 * {@code quota}, {@code not_found} ou {@code unavailable}.
 */
public class NasaProxyException extends RuntimeException {

    private final String code;

    public NasaProxyException(String code) {
        super(code);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
