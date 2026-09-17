package com.pat.controller.dto;

/**
 * Per-user GPS slope display multiplier ({@code slopeCoef}).
 * A road is rarely steeper than ~20°; coef 4.5 maps 20° to a vertical needle.
 */
public class GpsSlopeScalePreferenceDto {

    public static final double DEFAULT_COEF = 1.0;
    public static final double MIN_COEF = 0.5;
    public static final double MAX_COEF = 10.0;

    /** Multiplier applied to the slope diagram (1 = 1° on the needle). */
    private double slopeCoef = DEFAULT_COEF;

    public GpsSlopeScalePreferenceDto() {
    }

    public GpsSlopeScalePreferenceDto(double slopeCoef) {
        this.slopeCoef = slopeCoef;
    }

    public double getSlopeCoef() {
        return slopeCoef;
    }

    public void setSlopeCoef(double slopeCoef) {
        this.slopeCoef = slopeCoef;
    }
}
