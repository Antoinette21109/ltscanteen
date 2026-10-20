window.LT_API_BASE_URL = 'https://ltscanteen.onrender.com';

window.ltApiFetch = function (endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('ltToken') || localStorage.getItem('token');

    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', 'Bearer ' + token);
    }

    return fetch(window.LT_API_BASE_URL + endpoint, { ...options, headers });
};