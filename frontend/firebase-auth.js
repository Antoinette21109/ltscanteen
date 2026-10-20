import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    query,
    where
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut as firebaseSignOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const config = window.LT_FIREBASE_CONFIG;
const configured = config && config.apiKey && config.projectId && config.appId &&
    !Object.values(config).some((value) => String(value).startsWith('REPLACE_WITH_'));

if (configured) {
    try {
        const app = initializeApp(config);
        const auth = getAuth(app);
        const firestore = getFirestore(app);
        const authReady = new Promise((resolve) => {
            const unsubscribe = onAuthStateChanged(auth, (user) => {
                unsubscribe();
                resolve(user);
            });
        });

        window.ltFirebaseAuthReady = authReady.then(() => ({
            async createAccount(email, password) {
                try {
                    const credential = await createUserWithEmailAndPassword(auth, email, password);
                    return credential.user;
                } catch (error) {
                    throw new Error(firebaseErrorMessage(error));
                }
            },
            async signIn(email, password) {
                try {
                    const credential = await signInWithEmailAndPassword(auth, email, password);
                    return credential.user;
                } catch (error) {
                    throw new Error(firebaseErrorMessage(error));
                }
            },
            async getIdToken() {
                await authReady;
                return auth.currentUser ? auth.currentUser.getIdToken() : null;
            },
            async signOut() {
                await firebaseSignOut(auth);
            },
            async getMenuItems() {
                const snapshot = await getDocs(query(
                    collection(firestore, 'menuItems'),
                    where('is_available', '==', true)
                ));
                const today = new Date().toISOString().slice(0, 10);
                return snapshot.docs.map((itemDoc) => {
                    const item = itemDoc.data();
                    const promoActive = Number(item.promo_percent) > 0 &&
                        (!item.promo_start || item.promo_start <= today) &&
                        (!item.promo_end || item.promo_end >= today);
                    const basePrice = Number(item.price);
                    const price = promoActive
                        ? Math.round(basePrice * (100 - Number(item.promo_percent))) / 100
                        : basePrice;
                    return {
                        ...item,
                        id: Number(itemDoc.id),
                        price,
                        base_price: basePrice,
                        promo_percent: item.promo_percent ?? null,
                        promo_active: promoActive,
                        img: item.image_url,
                        desc: item.description,
                        popular: Boolean(item.popular),
                        is_available: Boolean(item.is_available)
                    };
                }).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
            },
            async getParentProfile() {
                if (!auth.currentUser) throw new Error('Sign in to load your profile.');
                const profileRef = doc(firestore, 'users', auth.currentUser.uid);
                const [profileSnapshot, childrenSnapshot] = await Promise.all([
                    getDoc(profileRef),
                    getDocs(collection(profileRef, 'children'))
                ]);
                if (!profileSnapshot.exists()) throw new Error('Your Firebase profile is not set up yet.');
                const profile = profileSnapshot.data();
                return {
                    id: auth.currentUser.uid,
                    username: profile.email || auth.currentUser.email,
                    ...profile,
                    reminders: {
                        email_enabled: Number(profile.reminder_preferences?.email_enabled || 0),
                        push_enabled: Number(profile.reminder_preferences?.push_enabled || 0)
                    },
                    children: childrenSnapshot.docs.map((childDoc) => ({
                        ...childDoc.data(),
                        id: childDoc.id
                    })).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
                };
            },
            async getMyOrders() {
                if (!auth.currentUser) throw new Error('Sign in to load orders.');
                const ordersQuery = query(
                    collection(firestore, 'orders'),
                    where('user_id', '==', auth.currentUser.uid)
                );
                const snapshot = await getDocs(ordersQuery);
                return snapshot.docs.map((orderDoc) => {
                    const order = orderDoc.data();
                    return {
                        ...order,
                        id: orderDoc.id,
                        items: typeof order.items === 'string' ? order.items : JSON.stringify(order.items || [])
                    };
                }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            }
        }));
    } catch (error) {
        console.error('Firebase initialization failed:', error);
        window.ltFirebaseAuthReady = Promise.resolve(null);
    }
} else {
    window.ltFirebaseAuthReady = Promise.resolve(null);
}

function firebaseErrorMessage(error) {
    const messages = {
        'auth/email-already-in-use': 'An account with this email already exists. Please sign in instead.',
        'auth/invalid-credential': 'Invalid email or password.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/network-request-failed': 'Could not connect to Firebase. Check your internet connection and try again.',
        'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase.',
        'auth/unauthorized-domain': 'This website domain is not authorized in Firebase Authentication.',
        'auth/weak-password': 'Password must be at least 6 characters.',
        'auth/too-many-requests': 'Too many attempts. Please wait and try again.'
    };
    return messages[error.code] || 'Firebase sign-in failed. Please try again.';
}
