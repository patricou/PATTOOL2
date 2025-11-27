package com.pat.service;

import com.pat.repo.domain.ChatRequest;
import com.pat.repo.ChatRequestRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.nio.charset.StandardCharsets;
import java.util.*;

@Service
public class ChatService {

    private static final Logger log = LoggerFactory.getLogger(ChatService.class);

    @Value("${openai.key:}")
    private String apiKey;

    @Value("${openai.api:https://api.openai.com/v1/chat/completions}")
    private String apiUrl;

    @Value("${app.maxContextSize:10000}")
    private int maxContextSize;
    
    // Maximum number of chat history records to load from database (default: 100)
    // This prevents loading entire history into memory
    @Value("${app.chat.maxHistoryRecords:100}")
    private int maxHistoryRecords;

    private final RestTemplate restTemplate;
    private final ChatRequestRepository chatRequestRepository;

    public ChatService(RestTemplate restTemplate, ChatRequestRepository chatRequestRepository) {
        this.restTemplate = restTemplate;
        this.chatRequestRepository = chatRequestRepository;
    }

    public  String getChatResponse(String userInput, boolean withHistoricalContext, boolean takeXlast) {
        
        // Check if API key is available
        if (apiKey == null || apiKey.trim().isEmpty()) {
            log.warn("OpenAI API key is not configured. Returning mock response.");
            return "OpenAI API key is not configured. Please configure the 'openai.key' property in application.properties";
        }
        
        // Récupérer seulement les N derniers enregistrements pour éviter de charger tout l'historique en mémoire
        // This prevents memory leak when chat history grows large
        Pageable pageable = PageRequest.of(0, maxHistoryRecords);
        List<ChatRequest> chatHistory = chatRequestRepository.findRecentChatRequests(pageable);

        // Construire le contexte de la conversation ( if without context it is less expensive )
        String context = withHistoricalContext ?
                //true
                buildContext(chatHistory, userInput,takeXlast)
                :
                // false
                "\nUser: " + userInput;

        //log.info("Context : {} ",context);

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + apiKey);
        headers.set("Content-Encoding", "gzip");
        headers.setContentType(MediaType.APPLICATION_JSON);
        //headers.setContentType(MediaType.parseMediaType("application/json; charset=UTF-8"));


        // Construire le corps de la requête en utilisant une Map
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("messages", List.of(Map.of("role", "user", "content", context)));
        requestBody.put("max_tokens", 2000);
        requestBody.put("model", "gpt-4o");  // Use the correct model you have access to

        //log.info("Request Body :  " + requestBody);

        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(requestBody, headers);
        ResponseEntity<String> response = restTemplate.exchange(apiUrl, HttpMethod.POST, entity, String.class);

        // Enregistrer la nouvelle requête et la réponse dans la base de données
        ChatRequest chatRequest = new ChatRequest(userInput, response.getBody());

        chatRequestRepository.save(chatRequest);

        // Specials char were badly displayed 20241110
        //return  decodeUtf8(response.getBody());
        return response.getBody();
    }

    private String buildContext(List<ChatRequest> chatHistory, String userInput, boolean takeXlast) {
        // Determine the max size for context to avoid payload too large
        // int maxContextSize = 10000; // Adjust this value as needed
        StringBuilder contextBuilder = new StringBuilder();
        StringBuilder contextBuilder2 = new StringBuilder();

        List<ChatRequest> chatHistory2 = new ArrayList<ChatRequest>();

        // Reverse the chat history list
        if ( takeXlast ) Collections.reverse(chatHistory);

        for (ChatRequest chatRequest : chatHistory) {
            String entry = "User: " + chatRequest.getUserInput() + "\nAI: " + chatRequest.getChatResponse() + "\n";
            if (contextBuilder.length() + entry.length() > maxContextSize) {
                break;
            }

            contextBuilder.insert(0, entry);
            chatHistory2.add(chatRequest);
        }

        if ( takeXlast ) Collections.reverse(chatHistory2);

        for (ChatRequest chatRequest : chatHistory2) {
            String entry = "User: " + chatRequest.getUserInput() + "\nAI: " + chatRequest.getChatResponse() + "\n";

            contextBuilder2.insert(0, entry);
        }

        contextBuilder2.append("User: ").append(userInput);

        return contextBuilder2.toString();
    }

    private String decodeUtf8(String input) {
        byte[] bytes = input.getBytes(StandardCharsets.ISO_8859_1);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    public void deletePatGptHistorical(){
        chatRequestRepository.deleteAll();
    }
}
