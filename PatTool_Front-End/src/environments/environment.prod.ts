// The file contents for the current environment will overwrite these during build.
// The build system defaults to the dev environment which uses `environment.ts`, but if you do
// `ng build --env=prod` then `environment.prod.ts` will be used instead.
// 20240530 --> good one : ng build --environment=prod --sourcemaps=false
// The list of which env maps to which file can be found in `.angular-cli.json`.

// ng build --env=prod  --base-href=/

export const environment = {
    production: true,
    // Keycloak url
    //prod
    keykloakBaseUrl: 'https://www.patrickdeschamps.com:8543/auth',
    serviceBaseUrl: 'https://www.patrickdeschamps.com:8543/database',
    API_URL: "/api/",
    URL4PATGPT: "/",
    API_URL4FILE: "/uploadfile",
    API_URL4FILEONDISK: "/uploadondisk",
    //fire base config
    firebase: {
        apiKey: "AIzaSyBJFAKMyDO_lmqBYUwW6CWjBIMTHyFGZKc",
        authDomain: "sportpat-5e155.firebaseapp.com",
        databaseURL: "https://sportpat-5e155.firebaseio.com",
        projectId: "sportpat-5e155",
        storageBucket: "sportpat-5e155.appspot.com",
        messagingSenderId: "193416492629"
    },
    // Langages for the translator
    langs: ["ar", "cn", "de", "el", "en", "es", "fr", "he", "in", "it", "jp", "ru"]
};
