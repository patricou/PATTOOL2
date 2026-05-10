package com.pat.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Liens externes du bandeau assistant (facturation / usage / quotas), configurables dans
 * {@code application.properties} sous le préfixe {@code assistant.billing.*}.
 */
@Component
@ConfigurationProperties(prefix = "assistant.billing")
public class AssistantBillingLinksProperties {

    private String openaiBillingUrl = "https://platform.openai.com/settings/organization/billing";
    private String openaiUsageUrl = "https://platform.openai.com/usage";
    private String anthropicUrl = "https://console.anthropic.com/settings/plans";
    private String geminiRateLimitUrl =
            "https://aistudio.google.com/rate-limit?timeRange=last-28-days&hl=fr&project=gen-lang-client-0509711942";
    private String geminiApiKeysUrl = "https://aistudio.google.com/app/apikey";

    public String getOpenaiBillingUrl() {
        return openaiBillingUrl;
    }

    public void setOpenaiBillingUrl(String openaiBillingUrl) {
        this.openaiBillingUrl = openaiBillingUrl;
    }

    public String getOpenaiUsageUrl() {
        return openaiUsageUrl;
    }

    public void setOpenaiUsageUrl(String openaiUsageUrl) {
        this.openaiUsageUrl = openaiUsageUrl;
    }

    public String getAnthropicUrl() {
        return anthropicUrl;
    }

    public void setAnthropicUrl(String anthropicUrl) {
        this.anthropicUrl = anthropicUrl;
    }

    public String getGeminiRateLimitUrl() {
        return geminiRateLimitUrl;
    }

    public void setGeminiRateLimitUrl(String geminiRateLimitUrl) {
        this.geminiRateLimitUrl = geminiRateLimitUrl;
    }

    public String getGeminiApiKeysUrl() {
        return geminiApiKeysUrl;
    }

    public void setGeminiApiKeysUrl(String geminiApiKeysUrl) {
        this.geminiApiKeysUrl = geminiApiKeysUrl;
    }
}
