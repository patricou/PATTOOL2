package com.pat.converter;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Custom deserializer to handle roles field that can come as either:
 * - A JSON array (e.g., ["ROLE_USER", "ROLE_ADMIN"])
 * - A comma-separated string (e.g., "ROLE_USER,ROLE_ADMIN")
 * 
 * Converts arrays to comma-separated strings to match the Member entity's String type.
 */
public class RolesDeserializer extends JsonDeserializer<String> {

    @Override
    public String deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
        JsonToken token = p.getCurrentToken();
        
        if (token == JsonToken.START_ARRAY) {
            // Handle array: ["ROLE_USER", "ROLE_ADMIN"] -> "ROLE_USER,ROLE_ADMIN"
            List<String> roles = new ArrayList<>();
            while (p.nextToken() != JsonToken.END_ARRAY) {
                if (p.getCurrentToken() == JsonToken.VALUE_STRING) {
                    roles.add(p.getText());
                }
            }
            return String.join(",", roles);
        } else if (token == JsonToken.VALUE_STRING) {
            // Handle string: already in the correct format
            return p.getText();
        } else if (token == JsonToken.VALUE_NULL) {
            // Handle null
            return null;
        } else {
            // For other token types, try to get as string
            return p.getValueAsString();
        }
    }
}


