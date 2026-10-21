window.LT_API_BASE_URL = 'https://ltscanteen.onrender.com';
window.LT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyA68KBfRbLNywI7ajLFoaH8VbIYfVmeCPM",
  authDomain: "ltscanteen-b0b31.firebaseapp.com",
  projectId: "ltscanteen-b0b31",
  storageBucket: "ltscanteen-b0b31.firebasestorage.app",
  messagingSenderId: "854216719438",
  appId: "1:854216719438:web:036a7541aa0d4bc62e171f",
  measurementId: "G-9YTBQV0F06"
};

window.ltApiFetch = function (endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('ltToken') || localStorage.getItem('token');

    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', 'Bearer ' + token);
    }

    return fetch(window.LT_API_BASE_URL + endpoint, { ...options, headers });
};
