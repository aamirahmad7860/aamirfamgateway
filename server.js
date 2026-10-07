const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 5000;

// 👇 यहाँ तुम्हारा MongoDB लिंक पहले से डाल दिया गया है 👇
const MONGO_URI = 'mongodb+srv://syedhack7282_db_user:7dE2yyCbnQvnWXUp@cluster0.s2wp3on.mongodb.net/aamirmodz?appName=Cluster0';
const JWT_SECRET = 'aamir_modz_super_secret_key_2024';

const app = express();
app.use(cors());
app.use(express.json());

// डेटाबेस कनेक्ट करें
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000, // 5 सेकंड में कनेक्ट नहीं हुआ तो एरर दे
    bufferCommands: false            // कनेक्शन बनने तक क्वेरी को रोके नहीं
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.log('❌ MongoDB Error:', err.message));

// --- मॉडल्स ---
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    upiId: { type: String, default: '' },
    gmailAppPassword: { type: String, default: '' },
    apiKey: { type: String, unique: true },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    orderId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'success', 'expired'], default: 'pending' },
    reference: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- मिडलवेयर ---
const auth = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ ok: false, error: 'Access Denied' });
    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ ok: false, error: 'Invalid Token' });
    }
};

// --- API राउट्स ---
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ ok: false, error: 'Email already exists' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = 'Am_' + Math.random().toString(36).substring(2, 18);
        const user = new User({ name, email, password: hashedPassword, apiKey });
        await user.save();
        res.json({ ok: true, message: 'Account created successfully' });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
        return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, user: { name: user.name, email: user.email, upiId: user.upiId, apiKey: user.apiKey } });
});

app.get('/api/dashboard', auth, async (req, res) => {
    const today = new Date(); today.setHours(0,0,0,0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const transactions = await Transaction.find({ userId: req.user.id, status: 'success' });
    const todayTotal = transactions.filter(t => t.createdAt >= today).reduce((sum, t) => sum + t.amount, 0);
    const monthTotal = transactions.filter(t => t.createdAt >= thisMonth).reduce((sum, t) => sum + t.amount, 0);
    const allTimeTotal = transactions.reduce((sum, t) => sum + t.amount, 0);
    res.json({ ok: true, today: todayTotal, month: monthTotal, allTime: allTimeTotal, recent: transactions.slice(-5) });
});

app.post('/api/profile', auth, async (req, res) => {
    const { upiId, gmailAppPassword } = req.body;
    await User.findByIdAndUpdate(req.user.id, { upiId, gmailAppPassword });
    res.json({ ok: true, message: 'Profile updated' });
});

app.post('/api/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (!await bcrypt.compare(currentPassword, user.password)) {
        return res.status(400).json({ ok: false, error: 'Incorrect current password' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true, message: 'Password updated' });
});

app.post('/api/create_order', async (req, res) => {
    const { api_key, amount, order_id, redirect_url } = req.body;
    const user = await User.findOne({ apiKey: api_key });
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid API Key' });
    const existing = await Transaction.findOne({ orderId: order_id });
    if (existing && existing.status === 'pending') {
        return res.json({ ok: true, existing: true, order_id, checkout_url: `http://localhost:${PORT}/pay/${order_id}` });
    }
    if (existing && existing.status === 'success') {
        return res.status(409).json({ ok: false, error: 'Order already paid' });
    }
    const newOrder = new Transaction({
        userId: user._id, orderId: order_id || 'ORD_' + Date.now(), amount: amount, status: 'pending'
    });
    await newOrder.save();
    res.json({ ok: true, order_id: newOrder.orderId, amount: amount, status: 'pending', checkout_url: `http://localhost:${PORT}/pay/${newOrder.orderId}` });
});

app.post('/api/verify', async (req, res) => {
    const { api_key, order_id } = req.body;
    const user = await User.findOne({ apiKey: api_key });
    const transaction = await Transaction.findOne({ orderId: order_id, userId: user._id });
    if (!transaction) return res.status(404).json({ ok: false, error: 'Order not found' });
    if (transaction.status === 'success') return res.json({ ok: true, status: 'success', paid: true, reference: transaction.reference });
    const { found, utr } = await checkGmailForPayment(user.email, user.gmailAppPassword, transaction.amount);
    if (found) {
        transaction.status = 'success'; transaction.reference = utr;
        await transaction.save();
        res.json({ ok: true, status: 'success', paid: true, reference: utr });
    } else { res.json({ ok: true, status: 'pending', paid: false }); }
});

async function checkGmailForPayment(userEmail, appPassword, expectedAmount) {
    if (!appPassword) return { found: false, utr: '' };
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: userEmail, pass: appPassword }, logger: false });
    let found = false; let utr = '';
    try {
        await client.connect();
        let lock = await client.getMailboxLock('INBOX');
        const since = new Date(Date.now() - 15 * 60 * 1000);
        for await (let message of client.fetch({ since: since }, { source: true })) {
            const parsed = await simpleParser(message.source);
            const text = parsed.text || '';
            if ((text.includes('Rs.') || text.includes('INR')) && text.includes(expectedAmount.toString())) {
                const utrMatch = text.match(/UTR[:\s]*(\d+)/i) || text.match(/Ref[:\s]*(\d+)/i);
                if (utrMatch) { utr = utrMatch[1]; found = true; break; }
            }
        }
        lock.release(); await client.logout();
    } catch (err) { console.log('IMAP Error:', err.message); }
    return { found, utr };
}

// --- फ्रंटएंड HTML (डैशबोर्ड UI) ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Aamir Modz - Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background-color: #f3f4f6; font-family: sans-serif; }</style>
</head>
<body class="min-h-screen flex justify-center items-center p-4">
    <div id="authScreen" class="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6">
        <h2 class="text-2xl font-bold text-gray-800 text-center mb-1">Welcome back</h2>
        <p class="text-gray-500 text-sm text-center mb-6">Sign in to Aamir Modz Dashboard</p>
        <div class="flex bg-gray-100 rounded-lg p-1 mb-6">
            <button id="tabLogin" onclick="switchTab('login')" class="flex-1 py-2 text-sm font-semibold rounded-md bg-white text-indigo-600 shadow-sm">Sign In</button>
            <button id="tabSignup" onclick="switchTab('signup')" class="flex-1 py-2 text-sm font-semibold text-gray-500">Create Account</button>
        </div>
        <div id="loginForm">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Email</label>
            <input type="email" id="loginEmail" placeholder="you@example.com" class="w-full p-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Password</label>
            <input type="password" id="loginPassword" placeholder="Enter your password" class="w-full p-3 border border-gray-300 rounded-lg mb-6 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <button onclick="login()" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition">Sign In</button>
        </div>
        <div id="signupForm" class="hidden">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Full Name</label>
            <input type="text" id="signupName" placeholder="Your full name" class="w-full p-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Email</label>
            <input type="email" id="signupEmail" placeholder="you@example.com" class="w-full p-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Password</label>
            <input type="password" id="signupPassword" placeholder="Minimum 6 characters" class="w-full p-3 border border-gray-300 rounded-lg mb-6 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <button onclick="register()" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition">Create Account</button>
        </div>
    </div>

    <div id="dashboardScreen" class="hidden w-full max-w-md">
        <div class="bg-gray-900 text-white p-4 rounded-t-2xl flex justify-between items-center">
            <div class="flex items-center gap-2">
                <div class="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center font-bold">A</div>
                <h1 class="font-bold text-lg">Aamir Modz</h1>
            </div>
            <button onclick="logout()" class="text-sm bg-gray-800 px-3 py-1 rounded">Logout</button>
        </div>
        <div class="bg-gray-100 p-4 space-y-4 rounded-b-2xl">
            <div class="bg-white p-4 rounded-xl shadow-sm flex justify-between items-center">
                <div>
                    <p class="text-xs text-gray-500 font-semibold">TODAY</p>
                    <p class="text-2xl font-bold text-gray-800">₹<span id="todayTotal">0.00</span></p>
                    <p class="text-xs text-gray-400">0 transactions</p>
                </div>
                <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600">📅</div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm flex justify-between items-center">
                <div>
                    <p class="text-xs text-gray-500 font-semibold">THIS MONTH</p>
                    <p class="text-2xl font-bold text-gray-800">₹<span id="monthTotal">0.00</span></p>
                    <p class="text-xs text-gray-400">0 transactions</p>
                </div>
                <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600">📈</div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm flex justify-between items-center">
                <div>
                    <p class="text-xs text-gray-500 font-semibold">ALL TIME</p>
                    <p class="text-2xl font-bold text-gray-800">₹<span id="allTimeTotal">0.00</span></p>
                    <p class="text-xs text-gray-400">0 transactions</p>
                </div>
                <div class="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center text-yellow-600">📊</div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm space-y-3 mt-4">
                <a href="#" class="block text-gray-700 font-medium">⚙️ Integration (Gmail & UPI)</a>
                <a href="#" class="block text-gray-700 font-medium">🔑 API Key & Docs</a>
                <a href="#" class="block text-gray-700 font-medium">🔗 Payment Links</a>
                <a href="#" class="block text-gray-700 font-medium">👤 Profile & Password</a>
            </div>
            <div class="bg-indigo-50 border border-indigo-100 p-4 rounded-xl text-center">
                <p class="text-xs text-indigo-500 font-semibold mb-1">Your API Key</p>
                <p id="apiKeyDisplay" class="text-sm font-mono break-all text-indigo-800">Loading...</p>
            </div>
        </div>
    </div>

    <script>
        const API_URL = '/api';
        function switchTab(type) {
            document.getElementById('tabLogin').classList.toggle('bg-white', type === 'login');
            document.getElementById('tabLogin').classList.toggle('text-indigo-600', type === 'login');
            document.getElementById('tabLogin').classList.toggle('text-gray-500', type !== 'login');
            document.getElementById('tabSignup').classList.toggle('bg-white', type === 'signup');
            document.getElementById('tabSignup').classList.toggle('text-indigo-600', type === 'signup');
            document.getElementById('tabSignup').classList.toggle('text-gray-500', type !== 'signup');
            document.getElementById('loginForm').classList.toggle('hidden', type === 'signup');
            document.getElementById('signupForm').classList.toggle('hidden', type === 'login');
        }
        async function register() {
            const name = document.getElementById('signupName').value;
            const email = document.getElementById('signupEmail').value;
            const password = document.getElementById('signupPassword').value;
            const res = await fetch(API_URL + '/register', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password })
            });
            const data = await res.json();
            if (data.ok) { alert('Account created! Please sign in.'); switchTab('login'); }
            else { alert(data.error); }
        }
        async function login() {
            const email = document.getElementById('loginEmail').value;
            const password = document.getElementById('loginPassword').value;
            const res = await fetch(API_URL + '/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.ok) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('apiKey', data.user.apiKey);
                document.getElementById('authScreen').classList.add('hidden');
                document.getElementById('dashboardScreen').classList.remove('hidden');
                document.getElementById('apiKeyDisplay').innerText = data.user.apiKey;
                loadDashboard();
            } else { alert(data.error); }
        }
        async function loadDashboard() {
            const token = localStorage.getItem('token');
            const res = await fetch(API_URL + '/dashboard', { headers: { 'Authorization': token } });
            const data = await res.json();
            if (data.ok) {
                document.getElementById('todayTotal').innerText = data.today.toFixed(2);
                document.getElementById('monthTotal').innerText = data.month.toFixed(2);
                document.getElementById('allTimeTotal').innerText = data.allTime.toFixed(2);
            }
        }
        function logout() { localStorage.clear(); location.reload(); }
        if (localStorage.getItem('token')) {
            document.getElementById('authScreen').classList.add('hidden');
            document.getElementById('dashboardScreen').classList.remove('hidden');
            document.getElementById('apiKeyDisplay').innerText = localStorage.getItem('apiKey');
            loadDashboard();
        }
    </script>
</body>
</html>
    `);
});

// सर्वर शुरू करें
app.listen(PORT, () => console.log(`🚀 Aamir Modz Server running on port ${PORT}`));