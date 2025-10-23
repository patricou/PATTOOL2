package com.pat.converter;

import com.pat.repo.domain.Member;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/**
 * Converter to handle String to Member conversion
 * This handles the case where Spring tries to convert String parameters to Member objects
 */
@Component
public class StringToMemberConverter implements Converter<String, Member> {

    @Override
    public Member convert(String source) {
        if (source == null || source.trim().isEmpty()) {
            return null;
        }
        
        // Create a Member with just the id filled
        Member member = new Member();
        member.setId(source);
        
        return member;
    }
}