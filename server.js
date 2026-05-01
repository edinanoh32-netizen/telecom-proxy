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
const CREDENTIALS = {
    email: 'rawad.telecom@aloha.co.il',
    password: 'A12345678ab'
};



const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function login() {
    console.log("[1/3] Attempting to log into the telecom platform...");
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
    console.log(`[2/3] Searching database for Phone Number: ${phoneNumber}...`);
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
        console.log("      -> Search API Response:", data); // Prints the raw API result

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

async function updateLeadStatus(leadId, newStatus) {
    console.log(`      -> Sending API request to set Status to: ${newStatus}...`);
    const updateData = new URLSearchParams();
    updateData.append('leadId', leadId);
    updateData.append('newStatus', newStatus);

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
    const { phoneNumber, provider, method } = req.body;

    console.log(`\n======================================================`);
    console.log(`NEW REQUEST RECEIVED`);
    console.log(`Target Phone: ${phoneNumber} | Provider: ${provider} | Method: ${method}`);
    console.log(`======================================================`);

    // 1. Login
    const isLoggedIn = await login();
    if (!isLoggedIn) {
        console.log("❌ PROCESS FAILED: Could not log in to backend.");
        return res.status(500).json({ success: false, message: "Backend Login Failed. Check server credentials." });
    }
    console.log("✅ Successfully logged in and captured session cookies.");

    // 2. Find Lead ID
    const leadId = await getLeadIdByPhone(phoneNumber);
    if (!leadId) {
        console.log(`❌ PROCESS FAILED: Lead ID not found for ${phoneNumber}.`);
        return res.status(404).json({ success: false, message: "Lead ID not found for this phone number." });
    }
    console.log(`✅ Successfully extracted Lead ID: ${leadId}`);

    // 3. Execute logic
    console.log(`[3/3] Executing line update sequence...`);
    try {
        if (method === "freeze_then_activate") {
            
            // Step A: Freeze
            console.log("      >> Step A: Freezing line (Status 4)");
            await updateLeadStatus(leadId, "4");
            
            // Step B: Wait
            console.log("      >> Step B: Waiting 5 seconds for telecom system to sync...");
            await delay(5000); 

            // Step C: Activate
            console.log("      >> Step C: Reactivating line (Status 2)");
            await updateLeadStatus(leadId, "2");

        } else if (method === "direct_activate") {
            console.log("      >> Step A: Direct Activation (Status 2)");
            await updateLeadStatus(leadId, "2");
        }

        console.log(`✅ PROCESS COMPLETE: Line processed successfully for ${phoneNumber}.`);
        res.json({ success: true, message: "Line processed successfully!" });

    } catch (error) {
        console.error("❌ PROCESS ERROR:", error);
        res.status(500).json({ success: false, message: "An error occurred while updating the line." });
    }
    console.log(`======================================================\n`);
});

// Use Render's dynamically assigned port, or 3000 if running locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Telecom Gateway Server running on port ${PORT}`);
});
