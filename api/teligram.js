/**
 * index.js
 * 
 * IMPORTANT: To run this file, ensure your package.json has:
 * { "type": "module" }
 * 
 * Install dependencies:
 * npm install express node-telegram-bot-api firebase
 */

import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { initializeApp } from 'firebase/app';
import { 
    getFirestore, 
    collection, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    increment, 
    serverTimestamp, 
    query, 
    where, 
    getDocs 
} from 'firebase/firestore';

// =========================================================
// 1. CONFIGURATIONS
// =========================================================

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;
const REWARD_AMOUNT = 500;

// Placeholder Firebase Config (Client SDK)
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// =========================================================
// 2. INITIALIZATIONS
// =========================================================

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const server = express();

// Basic Express server to keep the backend alive on hosts
server.get('/', (req, res) => res.send('RG Task Bot Backend is running!'));
server.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));

// =========================================================
// 3. DATABASE HELPER FUNCTIONS
// =========================================================

/**
 * Creates a new user or merges with existing to ensure data integrity
 */
async function createOrEnsureUser(userId, name, photoURL, referralId) {
    const userRef = doc(db, 'users', userId.toString());
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
        await setDoc(userRef, {
            id: userId.toString(),
            name: name,
            photoURL: photoURL,
            coins: 0,
            reffer: 0,
            refferBy: referralId || null,
            tasksCompleted: 0,
            totalWithdrawals: 0,
            frontendOpened: false,
            rewardGiven: false
        }, { merge: true });
        console.log(`[DB] Created new user: ${userId}`);
    } else {
        // Update name and photo in case they changed, but preserve sensitive fields
        await setDoc(userRef, {
            name: name,
            photoURL: photoURL
        }, { merge: true });
    }
}

/**
 * Updates a specific field for a user
 */
async function updateField(userId, field, value) {
    const userRef = doc(db, 'users', userId.toString());
    await updateDoc(userRef, { [field]: value });
}

/**
 * Increments a numeric field for a user
 */
async function incrementField(userId, field, amount) {
    const userRef = doc(db, 'users', userId.toString());
    await updateDoc(userRef, { [field]: increment(amount) });
}

/**
 * Rewards the referrer and logs the transaction
 */
async function rewardReferrer(userId, referrerId) {
    try {
        const rewardRef = doc(db, 'ref_rewards', userId.toString());

        // Increment referrer's stats
        await incrementField(referrerId, 'coins', REWARD_AMOUNT);
        await incrementField(referrerId, 'reffer', 1);

        // Mark reward as given for the referred user
        await updateField(userId, 'rewardGiven', true);

        // Create reward ledger
        await setDoc(rewardRef, {
            userId: userId.toString(),
            referrerId: referrerId.toString(),
            reward: REWARD_AMOUNT,
            createdAt: serverTimestamp()
        });

        console.log(`[Worker] Successfully rewarded ${referrerId} for referring ${userId}`);
    } catch (error) {
        console.error(`[Worker] Error rewarding ${referrerId}:`, error.message);
    }
}

// =========================================================
// 4. TELEGRAM BOT HANDLERS
// =========================================================

/**
 * Utility to grab the user's profile picture link
 */
async function getProfilePhoto(userId) {
    try {
        const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
        if (photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const fileLink = await bot.getFileLink(fileId);
            return fileLink;
        }
    } catch (error) {
        console.log(`Could not fetch photo for ${userId}`);
    }
    return ""; // Empty string fallback
}

// Handle /start command and extract referrals
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';
    
    // Extract referral from /start <refId>
    let referralId = match[1] ? match[1] : null;

    // Prevent self-referral abuse
    if (referralId === userId.toString()) {
        referralId = null; 
    }

    // 1. Fetch Photo & Sync DB
    const photoURL = await getProfilePhoto(userId);
    await createOrEnsureUser(userId, firstName, photoURL, referralId);

    // 2. Prepare Welcome Message
    const image = 'https://i.ibb.co/pBcJwJ8h/uploaded-image.jpg';
    const caption = `👋 Hi! Welcome ${firstName} ⭐\nYaha aap tasks complete karke real rewards kama sakte ho!\n\n🔥 Daily Tasks\n🔥 Video Watch\n🔥 Mini Apps\n🔥 Referral Bonus\n🔥 Auto Wallet System\n\nReady to earn?\nTap START and your journey begins!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "▶ Open App", web_app: { url: "https://gautamramgopal480-source.github.io/RG-TASK-BOT-/" } }],
                [{ text: "📢 Channel", url: "https://t.me/rx7ox" }],
                [{ text: "🌐 Community", url: "https://t.me/rghackzone07" }]
            ]
        }
    };

    // 3. Send Message
    bot.sendPhoto(chatId, image, {
        caption: caption,
        reply_markup: options.reply_markup
    });
});

// =========================================================
// 5. REFERRAL WORKER LOGIC
// =========================================================

/**
 * Worker interval runs periodically to check for newly opened apps
 * by users who haven't had their referrer rewarded yet.
 */
setInterval(async () => {
    try {
        const usersRef = collection(db, 'users');
        
        // Query users who opened the frontend but their reward wasn't given yet
        // Note: You must create a composite index in Firestore for this query.
        const q = query(
            usersRef, 
            where('rewardGiven', '==', false), 
            where('frontendOpened', '==', true)
        );
        
        const querySnapshot = await getDocs(q);
        
        querySnapshot.forEach((document) => {
            const userData = document.data();
            
            if (userData.refferBy) {
                // User has a referrer, give reward
                rewardReferrer(userData.id, userData.refferBy);
            } else {
                // User opened app but has no referrer. 
                // Mark as given so we stop checking them in future cycles.
                updateField(userData.id, 'rewardGiven', true).catch(e => console.error(e));
            }
        });
    } catch (error) {
        // Suppress composite index errors initially unless debugging
        // console.error("[Worker] Query error (Check Firebase Indexes):", error.message);
    }
}, 3000); // Check every 3 seconds
      
