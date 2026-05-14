package com.pat.service;

/** Identifiants stables des cinq méthodes analytiques (JSON assistant & Mongo). */
public final class EuromillionsMethodIds {

    public static final String CHI2_GOF_UNIFORM = "chi2_gof_uniform";
    public static final String ENTROPY_NORMALIZED = "entropy_normalized";
    public static final String GAP_RECURRENCE = "gap_recurrence";
    public static final String SUM_CORRELATION = "sum_correlation";
    public static final String MONTE_CARLO_MAXFREQ = "monte_carlo_maxfreq";

    public static final String[] ORDERED = {
        CHI2_GOF_UNIFORM,
        ENTROPY_NORMALIZED,
        GAP_RECURRENCE,
        SUM_CORRELATION,
        MONTE_CARLO_MAXFREQ
    };

    private EuromillionsMethodIds() {}
}
