package com.pat.service;

import com.pat.repo.domain.EuromillionsDraw;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Cinq blocs de métriques sur une liste chronologique de tirages (statistiques descriptives &
 * tests simplifiés ; les tirages réels restent non prédictibles).
 */
final class EuromillionsMethodAnalyticsCalculator {

    private static final LocalDate STAR_CUT_1 = LocalDate.of(2011, 5, 10);
    private static final LocalDate STAR_CUT_2 = LocalDate.of(2016, 9, 27);

    private EuromillionsMethodAnalyticsCalculator() {}

    static Map<String, Map<String, Object>> computeAll(List<EuromillionsDraw> chronologic) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        int n = chronologic.size();
        if (n <= 0) {
            for (String id : EuromillionsMethodIds.ORDERED) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("note", "no_draws_in_scope");
                out.put(id, m);
            }
            return out;
        }

        out.put(EuromillionsMethodIds.CHI2_GOF_UNIFORM, chi2Block(chronologic));
        out.put(EuromillionsMethodIds.ENTROPY_NORMALIZED, entropyBlock(chronologic));
        out.put(EuromillionsMethodIds.GAP_RECURRENCE, gapBlock(chronologic));
        out.put(EuromillionsMethodIds.SUM_CORRELATION, correlationBlock(chronologic));
        out.put(EuromillionsMethodIds.MONTE_CARLO_MAXFREQ, monteCarloBlock(chronologic));
        return out;
    }

    private static int starPeriod(LocalDate d) {
        if (d == null) {
            return 2;
        }
        if (d.isBefore(STAR_CUT_1)) {
            return 0;
        }
        if (d.isBefore(STAR_CUT_2)) {
            return 1;
        }
        return 2;
    }

    private static int starMax(int period) {
        return switch (period) {
            case 0 -> 9;
            case 1 -> 11;
            default -> 12;
        };
    }

    private static double rnd4(double x) {
        return Math.round(x * 10000d) / 10000d;
    }

    /**
     * χ² Pearson sur effectifs agrégés : boules 1–50 sur 5n places ; étoiles par période réglementaire.
     */
    private static Map<String, Object> chi2Block(List<EuromillionsDraw> draws) {
        int n = draws.size();
        int[] mains = new int[51];
        List<Map<String, Object>> starPeriods = new ArrayList<>();
        int[] periodDrawCount = new int[3];

        for (EuromillionsDraw d : draws) {
            LocalDate date = d.getDrawDate();
            int pi = starPeriod(date);
            periodDrawCount[pi]++;
            List<Integer> nums = d.getNumbers();
            if (nums != null) {
                for (Integer b : nums) {
                    if (b != null && b >= 1 && b <= 50) {
                        mains[b]++;
                    }
                }
            }
        }

        int totalMainSlots = 5 * n;
        double expMain = totalMainSlots > 0 ? (double) totalMainSlots / 50d : 0d;
        double chi2Main = 0d;
        if (expMain > 0) {
            for (int b = 1; b <= 50; b++) {
                double diff = mains[b] - expMain;
                chi2Main += (diff * diff) / expMain;
            }
        }

        for (int pi = 0; pi < 3; pi++) {
            int pn = periodDrawCount[pi];
            int sm = starMax(pi);
            int[] sc = new int[sm + 1];
            for (EuromillionsDraw d : draws) {
                if (starPeriod(d.getDrawDate()) != pi) {
                    continue;
                }
                List<Integer> stars = d.getStars();
                if (stars == null) {
                    continue;
                }
                for (Integer s : stars) {
                    if (s != null && s >= 1 && s <= sm) {
                        sc[s]++;
                    }
                }
            }
            int slots = 2 * pn;
            double expS = sm > 0 && slots > 0 ? (double) slots / (double) sm : 0d;
            double chi2S = 0d;
            if (expS > 0) {
                for (int s = 1; s <= sm; s++) {
                    double diff = sc[s] - expS;
                    chi2S += (diff * diff) / expS;
                }
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("periodId", pi == 0 ? "P1" : pi == 1 ? "P2" : "P3");
            row.put("starMax", sm);
            row.put("drawsInPeriod", pn);
            row.put("chi2StarsNaive", rnd4(chi2S));
            row.put("dfStars", sm > 0 ? sm - 1 : 0);
            starPeriods.add(row);
        }

        Map<String, Object> block = new LinkedHashMap<>();
        block.put("chi2MainsNaive", rnd4(chi2Main));
        block.put("dfMains", 49);
        block.put("draws", n);
        block.put("periods", starPeriods);
        block.put(
                "note",
                "χ² naïf uniformité marges : boules sur 5n places ; étoiles par période (starMax FDJ). Hypothèses simplificatrices.");
        return block;
    }

    /** Entropie de Shannon normalisée (logs naturels) pour boules et étoiles par période. */
    private static Map<String, Object> entropyBlock(List<EuromillionsDraw> draws) {
        int n = draws.size();
        int[] mains = new int[51];
        List<Map<String, Object>> perStar = new ArrayList<>();
        int[] periodDrawCount = new int[3];

        for (EuromillionsDraw d : draws) {
            int pi = starPeriod(d.getDrawDate());
            periodDrawCount[pi]++;
            List<Integer> nums = d.getNumbers();
            if (nums != null) {
                for (Integer b : nums) {
                    if (b != null && b >= 1 && b <= 50) {
                        mains[b]++;
                    }
                }
            }
        }

        double totalMain = 5d * n;
        double hm = shannonNormalized(mains, 50, totalMain);
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("entropyMainsNormalized", rnd4(hm));
        block.put("draws", n);

        for (int pi = 0; pi < 3; pi++) {
            int pn = periodDrawCount[pi];
            int sm = starMax(pi);
            int[] sc = new int[sm + 1];
            for (EuromillionsDraw d : draws) {
                if (starPeriod(d.getDrawDate()) != pi) {
                    continue;
                }
                List<Integer> stars = d.getStars();
                if (stars == null) {
                    continue;
                }
                for (Integer s : stars) {
                    if (s != null && s >= 1 && s <= sm) {
                        sc[s]++;
                    }
                }
            }
            double totSlots = 2d * pn;
            double hs = shannonNormalized(sc, sm, totSlots);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("periodId", pi == 0 ? "P1" : pi == 1 ? "P2" : "P3");
            row.put("starMax", sm);
            row.put("entropyStarsNormalized", rnd4(hs));
            perStar.add(row);
        }
        block.put("periods", perStar);
        block.put("note", "H / log(K) avec probabilités empiriques sur les catégories utilisées (boules 50 ; étoiles par période).");
        return block;
    }

    /** Entropie normalisée dans [0,1] si totalMass > 0 et k >= 2. */
    private static double shannonNormalized(int[] counts1based, int k, double totalMass) {
        if (totalMass <= 0 || k < 2) {
            return 0d;
        }
        double h = 0d;
        for (int i = 1; i <= k; i++) {
            double p = counts1based[i] / totalMass;
            if (p > 0) {
                h -= p * Math.log(p);
            }
        }
        return h / Math.log(k);
    }

    /** Écarts moyens entre apparitions successives d'une même boule (indices de tirage). */
    private static Map<String, Object> gapBlock(List<EuromillionsDraw> draws) {
        int n = draws.size();
        List<List<Integer>> appearances = new ArrayList<>(51);
        for (int i = 0; i <= 50; i++) {
            appearances.add(new ArrayList<>());
        }
        for (int idx = 0; idx < n; idx++) {
            EuromillionsDraw d = draws.get(idx);
            List<Integer> nums = d.getNumbers();
            if (nums == null) {
                continue;
            }
            for (Integer b : nums) {
                if (b != null && b >= 1 && b <= 50) {
                    appearances.get(b).add(idx);
                }
            }
        }
        List<Double> meanGaps = new ArrayList<>();
        for (int b = 1; b <= 50; b++) {
            List<Integer> ap = appearances.get(b);
            if (ap.size() < 2) {
                continue;
            }
            double sum = 0d;
            for (int i = 1; i < ap.size(); i++) {
                sum += ap.get(i) - ap.get(i - 1);
            }
            meanGaps.add(sum / (ap.size() - 1));
        }
        if (meanGaps.isEmpty()) {
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("note", "insufficient_recurrences");
            block.put("draws", n);
            return block;
        }
        double meanOfMeans = meanGaps.stream().mapToDouble(Double::doubleValue).average().orElse(0d);
        double var =
                meanGaps.stream().mapToDouble(g -> (g - meanOfMeans) * (g - meanOfMeans)).average().orElse(0d);
        double sd = Math.sqrt(var);
        double min = meanGaps.stream().mapToDouble(Double::doubleValue).min().orElse(0d);
        double max = meanGaps.stream().mapToDouble(Double::doubleValue).max().orElse(0d);
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("ballsWithAtLeastTwoAppearances", meanGaps.size());
        block.put("meanOfMeanGaps", rnd4(meanOfMeans));
        block.put("stdevMeanGapsAcrossBalls", rnd4(sd));
        block.put("minMeanGapAmongBalls", rnd4(min));
        block.put("maxMeanGapAmongBalls", rnd4(max));
        block.put("draws", n);
        block.put("note", "Pour chaque boule 1–50 : moyenne des écarts d’indice entre tirages consécutifs où elle sort ; puis synthèse sur les boules avec ≥ 2 sorties.");
        return block;
    }

    /** Corrélation Pearson entre somme des 5 boules et somme des 2 étoiles (par tirage). */
    private static Map<String, Object> correlationBlock(List<EuromillionsDraw> draws) {
        int n = draws.size();
        double sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
        int used = 0;
        for (EuromillionsDraw d : draws) {
            List<Integer> nums = d.getNumbers();
            List<Integer> stars = d.getStars();
            if (nums == null || nums.size() != 5 || stars == null || stars.size() != 2) {
                continue;
            }
            int sx = 0;
            boolean ok = true;
            for (Integer b : nums) {
                if (b == null || b < 1 || b > 50) {
                    ok = false;
                    break;
                }
                sx += b;
            }
            int sm = starMax(starPeriod(d.getDrawDate()));
            int sy = 0;
            for (Integer s : stars) {
                if (s == null || s < 1 || s > sm) {
                    ok = false;
                    break;
                }
                sy += s;
            }
            if (!ok) {
                continue;
            }
            sumX += sx;
            sumY += sy;
            sumXX += (double) sx * sx;
            sumYY += (double) sy * sy;
            sumXY += (double) sx * sy;
            used++;
        }
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("drawsTotal", n);
        block.put("drawsUsedCompleteGrid", used);
        if (used < 3) {
            block.put("pearsonR", null);
            block.put("note", "too_few_complete_draws");
            return block;
        }
        double meanX = sumX / used;
        double meanY = sumY / used;
        double cov = sumXY / used - meanX * meanY;
        double vx = sumXX / used - meanX * meanX;
        double vy = sumYY / used - meanY * meanY;
        double den = Math.sqrt(Math.max(vx, 0d) * Math.max(vy, 0d));
        Double r = den > 1e-12 ? cov / den : null;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("pearsonR", r != null ? rnd4(r) : null);
        result.put(
                "note",
                "Corrélation entre Σ boules et Σ étoiles sur les tirages avec grille complète valide pour la période d’étoiles.");
        block.putAll(result);
        return block;
    }

    /**
     * Fréquence maximale observée sur les 50 boules vs simulations sous uniforme sans remplacement (n tirages).
     */
    private static Map<String, Object> monteCarloBlock(List<EuromillionsDraw> draws) {
        int n = draws.size();
        int[] obs = new int[51];
        for (EuromillionsDraw d : draws) {
            List<Integer> nums = d.getNumbers();
            if (nums == null) {
                continue;
            }
            for (Integer b : nums) {
                if (b != null && b >= 1 && b <= 50) {
                    obs[b]++;
                }
            }
        }
        int maxObs = 0;
        for (int b = 1; b <= 50; b++) {
            maxObs = Math.max(maxObs, obs[b]);
        }

        final int reps = 800;
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        int ge = 0;
        for (int rep = 0; rep < reps; rep++) {
            int[] sim = new int[51];
            for (int i = 0; i < n; i++) {
                drawFiveDistinct(sim, rnd);
            }
            int maxSim = 0;
            for (int b = 1; b <= 50; b++) {
                maxSim = Math.max(maxSim, sim[b]);
            }
            if (maxSim >= maxObs) {
                ge++;
            }
        }
        double pEmp = (ge + 1d) / (reps + 1d);
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("maxBallFrequencyObserved", maxObs);
        block.put("monteCarloReplications", reps);
        block.put("countSimMaxGeObserved", ge);
        block.put("empiricalPValueMaxFreq", rnd4(pEmp));
        block.put("draws", n);
        block.put(
                "note",
                "Réplications Monte Carlo : même n ; chaque tirage simulé tire 5 boules distinctes uniformément parmi 50 ; p-value empirique pour la fréquence max.");
        return block;
    }

    private static void drawFiveDistinct(int[] counts1to50, ThreadLocalRandom rnd) {
        boolean[] taken = new boolean[51];
        int picked = 0;
        while (picked < 5) {
            int x = rnd.nextInt(1, 51);
            if (!taken[x]) {
                taken[x] = true;
                counts1to50[x]++;
                picked++;
            }
        }
    }
}
