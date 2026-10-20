window.LT_API_BASE_URL = 'https://ltscanteen.onrender.com';
window.LT_FIREBASE_CONFIG = {
    apiKey: 'REPLACE_WITH_FIREBASE_WEB_API_KEY',
    authDomain: 'REPLACE_WITH_FIREBASE_PROJECT_ID.firebaseapp.com',
    projectId: 'REPLACE_WITH_FIREBASE_PROJECT_ID',
    appId: 'REPLACE_WITH_FIREBASE_WEB_APP_ID'
};

window.ltApiFetch = function (endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('ltToken') || localStorage.getItem('token');

    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', 'Bearer ' + token);
    }

    return fetch(window.LT_API_BASE_URL + endpoint, { ...options, headers });
};