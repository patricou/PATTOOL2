package com.pat.service;

import com.pat.controller.HomeIOTController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Service
public class HomeIOTService {

    private static final Logger log = LoggerFactory.getLogger(HomeIOTService.class);

    private final RestTemplate restTemplate;

    @Value("${app.arduino.ip}")
    private String arduinoIp;

    @Value("${app.esp32.1.ip}")
    private String esp321Ip;

    public HomeIOTService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public  Map<String, Object> openOrClosePortail() {

        String url = "http://"+arduinoIp+"/api/openorclose";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String requestBody = "{\"command\": \"open\"}";
        HttpEntity<String> requestEntity = new HttpEntity<>(requestBody, headers);

        return callHttp(url, requestEntity);
    }

    public  Map<String, Object> testEthernetShield2() {

        String url = "http://"+arduinoIp+"/api/test";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String requestBody = "{\"command\": \"test\"}";
        HttpEntity<String> requestEntity = new HttpEntity<>(requestBody, headers);

        return callHttp(url, requestEntity);
    }

    private  Map<String, Object> callHttp(String url, HttpEntity<String> requestEntity){
        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    url,
                    HttpMethod.POST,
                    requestEntity,
                    Map.class
            );
            return  response.getBody();
        } catch (Exception e) {
            e.printStackTrace();
            Map map = new HashMap();
            map.put("Arduino Exception during the call to HTTP : ", e);
            return map;
        }
    }

    public String getStatusOfRelais1(){
        String url =  "http://"+esp321Ip+"/relay/status";

        try {
            // Effectuer la requête GET
            String response = restTemplate.getForObject(url, String.class);

            // Afficher la réponse
            log.info("Response Relais Status : " + response);

            return response;
        } catch (Exception e) {
            // Gérer les exceptions
            log.info("Error Relais Status: " + e.getMessage());
            return(e.getMessage());
        }
    }

    public String setStatusOfRelais1ToOn(){
        String url =  "http://"+esp321Ip+"/relay/on";

        try {
            // Effectuer la requête GET
            String response = restTemplate.getForObject(url, String.class);

            // Afficher la réponse
            log.info("Response Relais On : " + response);

            return response;
        } catch (Exception e) {
            // Gérer les exceptions
            log.info("Error Relais On: " + e.getMessage());
            return(e.getMessage());
        }
    }

    public String setStatusOfRelais1ToOff(){
        String url =  "http://"+esp321Ip+"/relay/off";

        try {
            // Effectuer la requête GET
            String response = restTemplate.getForObject(url, String.class);

            // Afficher la réponse
            log.info("Response Relais Off : " + response);

            return response;
        } catch (Exception e) {
            // Gérer les exceptions
            log.info("Error Relais off : " + e.getMessage());
            return(e.getMessage());
        }
    }

}
