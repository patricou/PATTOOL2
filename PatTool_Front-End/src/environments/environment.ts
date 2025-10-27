// The file contents for the current environment will overwrite these during build.
// The build system defaults to the dev environment which uses `environment.ts`, but if you do
// `ng build --env=prod` then `environment.prod.ts` will be used instead --> right  20241109
// The list of which env maps to which file can be found in `.angular-cli.json`.

export const environment = {
    production: false,
    // Keycloak url
    //prod
    //keykloakBaseUrl: 'https://www.patrickdeschamps.com:8543/auth',
    //serviceBaseUrl: 'https://www.patrickdeschamps.com:8543/database',
    //API_URL: "/api/",
    //API_URL4FILE: "/uploadfile/",
    //API_URL4FILEONDISK: "/uploadondisk/",
    //dev
    keykloakBaseUrl: 'http://localhost:8080/auth',
    serviceBaseUrl: 'http://localhost:8080/database',
    API_URL: "http://localhost:8000/api/",
    URL4PATGPT: "http://localhost:8000/",
    API_URL4FILE: "http://localhost:8000/uploadfile",
    API_URL4FILEONDISK: "http://localhost:8000/uploadondisk",
    //fire base config
    firebase: {
        apiKey: "AIzaSyBJFAKMyDO_lmqBYUwW6CWjBIMTHyFGZKc",
        authDomain: "sportpat-5e155.firebaseapp.com",
        databaseURL: "https://sportpat-5e155.firebaseio.com", // Keep for backward compatibility
        projectId: "sportpat-5e155",
        storageBucket: "sportpat-5e155.appspot.com",
        messagingSenderId: "193416492629",
        appId: "1:193416492629:web:your-app-id" // Add if available
    },
    // Langages for the translator
    langs: ["ar", "cn", "de", "el", "en", "es", "fr", "he", "in", "it", "jp", "ru"]
};
