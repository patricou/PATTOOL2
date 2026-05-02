package com.pat.config;

import com.pat.util.FriendlyErrorHtml;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.boot.web.error.ErrorAttributeOptions;
import org.springframework.boot.web.servlet.error.ErrorAttributes;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.ServletWebRequest;

/**
 * Remplace {@link org.springframework.boot.autoconfigure.web.servlet.error.BasicErrorController} pour servir
 * directement du HTML PatTool (évite la Whitelabel et la page Tomcat « HTTP Status 500 » quand la résolution MVC
 * de la vue d'erreur échoue).
 */
@RestController
@RequestMapping("${server.error.path:${error.path:/error}}")
public class PatToolErrorController implements ErrorController {

    private static final Logger log = LoggerFactory.getLogger(PatToolErrorController.class);

    private final ErrorAttributes errorAttributes;

    public PatToolErrorController(ErrorAttributes errorAttributes) {
        this.errorAttributes = errorAttributes;
    }

    @RequestMapping(produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> errorHtml(HttpServletRequest request) {
        try {
            HttpStatus status = getStatus(request);
            String[] td = titleAndDetail(status.value());
            String html = FriendlyErrorHtml.page(true, "fr", "Erreur", td[0], td[1], "Erreur · ");
            return ResponseEntity.status(status).contentType(MediaType.TEXT_HTML).body(html);
        } catch (Exception e) {
            log.warn("Could not build styled error page, using fallback: {}", e.getMessage());
            String fallback = "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"UTF-8\"/><title>Erreur · PatTool</title></head>"
                    + "<body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0b1220;color:#e2e8f0\">"
                    + "<p>PatTool — une erreur s'est produite. Réessayez plus tard.</p></body></html>";
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.TEXT_HTML)
                    .body(fallback);
        }
    }

    @RequestMapping
    public ResponseEntity<Map<String, Object>> error(HttpServletRequest request) {
        HttpStatus status = getStatus(request);
        if (status == HttpStatus.NO_CONTENT) {
            return ResponseEntity.status(status).build();
        }
        Map<String, Object> body = errorAttributes.getErrorAttributes(new ServletWebRequest(request),
                ErrorAttributeOptions.defaults());
        return ResponseEntity.status(status).body(body);
    }

    private static HttpStatus getStatus(HttpServletRequest request) {
        Integer code = (Integer) request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        if (code == null) {
            return HttpStatus.INTERNAL_SERVER_ERROR;
        }
        try {
            return HttpStatus.valueOf(code);
        } catch (Exception ex) {
            return HttpStatus.INTERNAL_SERVER_ERROR;
        }
    }

    static String[] titleAndDetail(int code) {
        return switch (code) {
            case 400 -> new String[]{
                    "Requête incorrecte",
                    "La requête envoyée au serveur est invalide ou mal formée."};
            case 401 -> new String[]{
                    "Non autorisé",
                    "Vous devez être identifié pour accéder à cette ressource."};
            case 403 -> new String[]{
                    "Accès refusé",
                    "Vous n'avez pas l'autorisation d'accéder à cette page ou cette API."};
            case 404 -> new String[]{
                    "Page introuvable",
                    "La ressource demandée n'existe pas, a été supprimée ou l'URL est incorrecte."};
            case 405 -> new String[]{
                    "Méthode non autorisée",
                    "Cette opération n'est pas permise pour cette ressource."};
            case 408 -> new String[]{
                    "Délai dépassé",
                    "Le serveur a mis trop de temps à recevoir la requête."};
            case 413 -> new String[]{
                    "Requête trop volumineuse",
                    "Les données envoyées dépassent la taille maximale acceptée."};
            case 429 -> new String[]{
                    "Trop de requêtes",
                    "Veuillez patienter avant d'essayer à nouveau."};
            case 500 -> new String[]{
                    "Erreur serveur",
                    "Une erreur inattendue s'est produite. Veuillez réessayer dans quelques instants."};
            case 502 -> new String[]{
                    "Passerelle incorrecte",
                    "Le serveur n'a pas reçu une réponse valide d'un service en amont."};
            case 503 -> new String[]{
                    "Service indisponible",
                    "Le service est temporairement indisponible. Réessayez plus tard."};
            case 504 -> new String[]{
                    "Délai d'attente dépassé",
                    "Le serveur n'a pas reçu de réponse à temps depuis un service distant."};
            default -> new String[]{
                    "Erreur " + code,
                    "Une erreur s'est produite. Veuillez réessayer plus tard."};
        };
    }
}
