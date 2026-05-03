const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(cors());
app.use(express.json());

// Setup Cookie Jar for automatic session handling
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const BASE_URL = 'https://www.telecom.co.il';

// Hardcoded Credentials
const CREDENTIALS = {
    email: 'rawad.telecom@aloha.co.il',
    password: 'A12345678ab'
};

// Memory storage for the 2-hour rate limit rule
const recentUpdates = new Map(); 
const BLOCK_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function login() {
    console.log("[1/4] Attempting to log into the telecom platform...");
    const loginData = new URLSearchParams();
    loginData.append('email', CREDENTIALS.email);
    loginData.append('password', CREDENTIALS.password);

    try {
        const response = await client.post(`${BASE_URL}/login/verifyLoginAjax`, loginData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        console.log("      -> Login API Response:", response.data);
        return response.data.result === true;
    } catch (error) {
        console.error("      -> Login failed:", error.message);
        return false;
    }
}

async function getLeadIdByPhone(phoneNumber) {
    console.log(`[2/4] Searching database for Phone Number: ${phoneNumber}...`);
    const searchData = new URLSearchParams();
    searchData.append('featureClass', 'P');
    searchData.append('style', 'full');
    searchData.append('maxRows', '12');
    searchData.append('phrase', phoneNumber);

    try {
        const response = await client.post(`${BASE_URL}/app/ajax/searchLeads`, searchData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        const data = response.data;
        console.log("      -> Search API Response:", data);

        let leadId = null;
        if (Array.isArray(data) && data.length > 0) {
            leadId = data[0].id || data[0].leadId || data[0].value;
        } else if (data && (data.id || data.leadId)) {
            leadId = data.id || data.leadId;
        }
        return leadId;
    } catch (error) {
        console.error("      -> Search error:", error.message);
        return null;
    }
}

// Fetch the special We4G ID for Wecom numbers
async function getWecomId(phoneNumber) {
    console.log(`[3/4] Fetching special Wecom ID for ${phoneNumber}...`);
    const wecomData = new URLSearchParams();
    wecomData.append('phone_number', phoneNumber);

    try {
        const response = await client.post(`${BASE_URL}/app/ajax/getWe4gPhoneNumberID`, wecomData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        console.log("      -> Wecom API Response:", response.data);
        if (response.data && response.data.result === true) {
            return response.data.id;
        }
        return null;
    } catch (error) {
        console.error("      -> Wecom ID fetch error:", error.message);
        return null;
    }
}

// Now accepts the wecomId parameter if available
async function updateLeadStatus(leadId, newStatus, wecomId = null) {
    console.log(`      -> Sending API request to set Status to: ${newStatus}...`);
    const updateData = new URLSearchParams();
    updateData.append('leadId', leadId);
    updateData.append('newStatus', newStatus);
    
    // Inject Wecom ID if this is a Wecom line
    if (wecomId) {
        updateData.append('we4g_ID', wecomId);
    }

    try {
        const response = await client.post(`${BASE_URL}/app/ajax/updateStatusTemporary`, updateData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        console.log("      -> Update API Response:", response.data);
        return true;
    } catch (error) {
        console.error("      -> Status update error:", error.message);
        return false;
    }
}

// The Main API Endpoint
app.post('/process-line', async (req, res) => {
    const { phoneNumber, provider, method, useBlockRule } = req.body;

    console.log(`\n======================================================`);
    console.log(`NEW REQUEST RECEIVED`);
    console.log(`Target Phone: ${phoneNumber} | Provider: ${provider} | Method: ${method} | BlockRule: ${useBlockRule}`);
    console.log(`======================================================`);

    // --- 2-Hour Cooldown Check ---
    if (useBlockRule) {
        const lastUpdate = recentUpdates.get(phoneNumber);
        if (lastUpdate && (Date.now() - lastUpdate < BLOCK_TIME_MS)) {
            console.log(`⏳ BLOCKED: ${phoneNumber} is on 2-hour cooldown.`);
            return res.status(429).json({ success: false, message: "تم تحديث هذا الرقم مؤخراً. يرجى المحاولة بعد ساعتين للتخفيف من الضغط." });
        }
    }

    // 1. Login
    const isLoggedIn = await login();
    if (!isLoggedIn) {
        console.log(" PROCESS FAILED: Could not log in to backend.");
        return res.status(500).json({ success: false, message: "حدث خطأ في النظام، يرجى المحاولة لاحقاً." });
    }

    // 2. Find standard Lead ID
    const leadId = await getLeadIdByPhone(phoneNumber);
    if (!leadId) {
        console.log(` PROCESS FAILED: Lead ID not found for ${phoneNumber}.`);
        return res.status(404).json({ success: false, message: "عذراً، هذا الرقم غير موجود في النظام." });
    }

    // 3. Fetch Wecom ID if the provider is Wecom
    let wecomId = null;
    if (provider === "wecom" || phoneNumber.startsWith('051')) {
        wecomId = await getWecomId(phoneNumber);
        if (!wecomId) {
            console.log(` PROCESS FAILED: Could not retrieve Wecom ID for ${phoneNumber}.`);
            return res.status(500).json({ success: false, message: "فشل في استخراج Wecom" });
        }
    } else {
        console.log(`[3/4] Skipping Wecom ID fetch (Not a Wecom number).`);
    }

    // 4. Execute logic
    console.log(`[4/4] Executing line update sequence...`);
    try {
        if (method === "freeze_then_activate") {
            console.log("      >> Step A: Freezing line (Status 4)");
            await updateLeadStatus(leadId, "4", wecomId);
            
            console.log("      >> Step B: Waiting 5 seconds for telecom system to sync...");
            await delay(5000); 

            console.log("      >> Step C: Reactivating line (Status 2)");
            await updateLeadStatus(leadId, "2", wecomId);

        } else if (method === "direct_activate") {
            console.log("      >> Step A: Direct Activation (Status 2)");
            await updateLeadStatus(leadId, "2", wecomId);
        }

        console.log(`✅ PROCESS COMPLETE: Line processed successfully for ${phoneNumber}.`);
        
        if (useBlockRule) recentUpdates.set(phoneNumber, Date.now());

        res.json({ success: true, message: "تم تحديث الخط بنجاح!" });

    } catch (error) {
        console.error("❌ PROCESS ERROR:", error);
        res.status(500).json({ success: false, message: "حدث خطأ أثناء التحديث، يرجى المحاولة مجدداً." });
    }
    console.log(`======================================================\n`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Telecom Gateway Server running on port ${PORT}`);
});
