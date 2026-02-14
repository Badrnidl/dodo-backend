const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Server misconfigured" });
    }

    const { userId, subscriptionId } = req.body;

    if (!userId || !subscriptionId) {
        return res.status(400).json({ error: "Missing userId or subscriptionId" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // Update profile with subscription ID
        const { error } = await supabase
            .from("profiles")
            .update({
                subscription_id: subscriptionId,
                plan: "premium", // Ensure they get the plan immediately
                auto_renew: true
            })
            .eq("id", userId);

        if (error) throw error;

        return res.status(200).json({ success: true, message: "Subscription linked" });

    } catch (err) {
        console.error("Link subscription error:", err);
        return res.status(500).json({ error: "Failed to link subscription" });
    }
};
