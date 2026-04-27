const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();

// Allow all websites to talk to this server
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post("/refresh", async (req, res) => {
    try {
        const response = await axios.post(
            "https://refresh.telecom.co.il/home/refreshNumber",
            `phone_number=${req.body.phone_number}`,
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        res.send(response.data);
    } catch (error) {
        res.status(500).send("Error connecting to Telecom");
    }
});

// Render automatically assigns a PORT variable
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));