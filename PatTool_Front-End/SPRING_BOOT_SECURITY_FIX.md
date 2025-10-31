# Fix pour l'erreur 401 Unauthorized en production

## Problème
L'erreur `GET https://www.patrickdeschamps.com/ net::ERR_HTTP_RESPONSE_CODE_FAILURE 401 (Unauthorized)` indique que Spring Boot Security bloque l'accès aux fichiers statiques Angular avant même que l'application ne puisse se charger.

## Solution : Configuration Spring Boot Security

### 1. Configuration de la sécurité Spring Boot

Vous devez configurer Spring Boot Security pour permettre l'accès aux fichiers statiques (index.html, JS, CSS, assets) sans authentification, tout en protégeant les endpoints API.

#### Exemple de configuration WebSecurityConfig (Java)

```java
@Configuration
@EnableWebSecurity
public class WebSecurityConfig extends KeycloakWebSecurityConfigurerAdapter {

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        super.configure(http);
        
        http
            .csrf().disable()
            .authorizeRequests()
                // Permettre l'accès aux fichiers statiques sans authentification
                .antMatchers("/", "/index.html", "/favicon.ico", "/robots.txt").permitAll()
                .antMatchers("/assets/**", "/**.js", "/**.css", "/**.map").permitAll()
                .antMatchers("/i18n/**", "/assets/i18n/**").permitAll()
                .antMatchers("/.well-known/**").permitAll()
                // Protéger les endpoints API
                .antMatchers("/api/**", "/database/**", "/uploadfile/**").authenticated()
                // Toutes les autres routes doivent servir index.html (pour le routing Angular)
                .anyRequest().permitAll()
            .and()
            .sessionManagement()
                .sessionCreationPolicy(SessionCreationPolicy.STATELESS);
    }

    @Override
    public void configure(WebSecurity web) throws Exception {
        // Permettre l'accès aux ressources statiques sans authentification
        web.ignoring()
            .antMatchers("/assets/**")
            .antMatchers("/**.js")
            .antMatchers("/**.css")
            .antMatchers("/**.map")
            .antMatchers("/i18n/**")
            .antMatchers("/favicon.ico")
            .antMatchers("/robots.txt")
            .antMatchers("/.well-known/**");
    }
}
```

#### Configuration avec application.properties ou application.yml

Si vous utilisez une configuration basée sur les propriétés, ajoutez ceci à votre `application.properties` ou `application.yml` :

**application.properties:**
```properties
# Permettre l'accès aux fichiers statiques
spring.security.permit-all.paths=/**,/assets/**,/**.js,/**.css,/**.map,/i18n/**,/favicon.ico,/robots.txt

# Configuration pour servir index.html pour toutes les routes Angular
spring.web.resources.add-mappings=true
spring.web.resources.static-locations=classpath:/static/
```

**application.yml:**
```yaml
spring:
  security:
    permit-all:
      paths:
        - /**
        - /assets/**
        - /**.js
        - /**.css
        - /**.map
        - /i18n/**
        - /favicon.ico
        - /robots.txt
  web:
    resources:
      add-mappings: true
      static-locations: classpath:/static/
```

### 2. Configuration du contrôleur pour servir index.html

Créez un contrôleur qui redirige toutes les routes Angular vers `index.html` :

```java
@Controller
public class AngularController {
    
    @RequestMapping(value = {"/", "/even", "/neweven", "/updeven/**", 
                            "/details-evenement/**", "/results", "/maps", 
                            "/links", "/links-admin", "/iot", "/patgpt"})
    public String index() {
        return "forward:/index.html";
    }
}
```

OU utilisez une configuration plus générique :

```java
@Controller
public class AngularController {
    
    @RequestMapping(value = "/**/{[path:[^\\.]*}")
    public String redirect() {
        return "forward:/index.html";
    }
}
```

### 3. Vérification de la configuration Keycloak

Assurez-vous que votre configuration Keycloak côté Spring Boot permet les redirections correctes :

```java
@Configuration
public class KeycloakConfig {
    
    @Bean
    public KeycloakConfigResolver keycloakConfigResolver() {
        return new KeycloakSpringBootConfigResolver();
    }
}
```

### 4. Points importants

1. **Les fichiers statiques doivent être accessibles sans authentification** : C'est crucial pour que l'application Angular puisse se charger et initialiser Keycloak.

2. **Le routing Angular** : Puisque vous utilisez `HashLocationStrategy`, les routes Angular utilisent le format `/#/route`. Assurez-vous que le serveur sert toujours `index.html` pour la racine `/`.

3. **Les endpoints API doivent rester protégés** : Seuls les fichiers statiques doivent être accessibles sans authentification. Les endpoints `/api/**`, `/database/**`, etc. doivent rester protégés.

### 5. Test de la configuration

Après avoir appliqué ces changements :

1. Redémarrez votre application Spring Boot
2. Accédez à `https://www.patrickdeschamps.com/` 
3. Vous devriez voir `index.html` se charger (sans erreur 401)
4. Keycloak devrait ensuite rediriger vers la page de login si nécessaire

### 6. Ordre de chargement

L'ordre correct est :
1. ✅ Serveur Spring Boot sert `index.html` (sans authentification)
2. ✅ Angular charge et exécute `main.ts`
3. ✅ Keycloak s'initialise (`KeycloakService.init()`)
4. ✅ Si l'utilisateur n'est pas authentifié, Keycloak redirige vers la page de login
5. ✅ Après authentification, l'application Angular se charge complètement

### 7. Problèmes connus résolus dans ce fix

- ✅ L'intercepteur HTTP Angular ne tente plus d'ajouter un token aux requêtes de fichiers statiques
- ✅ Gestion d'erreur améliorée lorsque Keycloak n'est pas encore initialisé
- ✅ Configuration Spring Boot pour permettre l'accès aux fichiers statiques

## Notes importantes

- ⚠️ Assurez-vous que votre backend Spring Boot est dans le répertoire `../PatTool_Back-End/` (relatif au frontend)
- ⚠️ Vérifiez que les fichiers Angular sont bien compilés dans `PatTool_Back-End/src/main/resources/static/`
- ⚠️ Après avoir modifié la configuration Spring Boot, reconstruisez et redéployez l'application

