/**
 * Capacitor Android/iOS build. The UI is loaded from the phone (https://localhost),
 * so API calls must use the public PatTool origin instead of a relative /api/.
 */
export const environment = {
    production: true,
    keykloakBaseUrl: 'https://www.patrickdeschamps.com:8543/auth',
    serviceBaseUrl: 'https://www.patrickdeschamps.com:8543/database',
    API_URL: 'https://www.patrickdeschamps.com/api/',
    API_URL4FILE: 'https://www.patrickdeschamps.com/uploadfile',
    API_URL4FILEONDISK: 'https://www.patrickdeschamps.com/api/fsphotos',
    API_URL4UPLOADFILEONDISK: 'https://www.patrickdeschamps.com/uploadondisk',
    sharePublicOrigin: 'https://www.patrickdeschamps.com',
    langs: ["ar", "cn", "de", "el", "en", "es", "fr", "he", "in", "it", "jp", "ru"]
};
