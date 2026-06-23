package com.pat.controller.dto;

import java.util.List;

/**
 * Result of a time-zone conversion (source + one or more targets).
 */
public class TimezoneConvertResponseDto {

    private TimezoneInstantDto input;
    private List<TimezoneInstantDto> outputs;
    private String instantUtc;

    public TimezoneConvertResponseDto() {
    }

    public TimezoneInstantDto getInput() {
        return input;
    }

    public void setInput(TimezoneInstantDto input) {
        this.input = input;
    }

    public List<TimezoneInstantDto> getOutputs() {
        return outputs;
    }

    public void setOutputs(List<TimezoneInstantDto> outputs) {
        this.outputs = outputs;
    }

    public String getInstantUtc() {
        return instantUtc;
    }

    public void setInstantUtc(String instantUtc) {
        this.instantUtc = instantUtc;
    }
}
