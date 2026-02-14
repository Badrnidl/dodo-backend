const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Config error" });
    }

    const { userId, subscriptionId, customerId } = req.body;

    if (!userId || !subscriptionId) {
        return res.status(400).json({ error: "Missing parameters: userId and subscriptionId are required" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        const { error } = await supabase
            .from("profiles")
            .update({
                subscription_id: subscriptionId,
                customer_id: customerId || null,
                plan: "premium",
                auto_renew: true,
                updated_at: new Date().toISOString()
            })
            .eq("id", userId);

        if (error) throw error;

        return res.status(200).json({ success: true, message: `Linked subscription ${subscriptionId} to user ${userId}` });
    } catch (err) {
        console.error("Fix error:", err);
        return res.status(500).json({ error: err.message });
    }
};
