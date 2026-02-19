const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        return res.status(200).end();
    }

    // Set CORS headers for all responses
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // Validate env vars
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const DODO_PAYMENTS_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
    const DODO_API_BASE = process.env.DODO_LIVE === "true"
        ? "https://live.dodopayments.com"
        : "https://test.dodopayments.com";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
        return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
    }

    // Validate Dodo API Key specifically
    if (!DODO_PAYMENTS_API_KEY) {
        console.error("Missing DODO_PAYMENTS_API_KEY env var");
        return res.status(500).json({ error: "Server misconfigured: missing Dodo Payments API Key" });
    }

    const { userId, subscriptionId, autoRenew } = req.body;

    console.log(`Received toggle request for User: ${userId}, Sub: ${subscriptionId}, AutoRenew: ${autoRenew}`);

    if (!userId || !subscriptionId || typeof autoRenew !== "boolean") {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // 0. Verify the user actually owns this subscription
        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("subscription_id")
            .eq("id", userId)
            .single();

        if (profileError || !profile || profile.subscription_id !== subscriptionId) {
            return res.status(403).json({ error: "Invalid subscription for this user" });
        }

        // 1. Call Dodo Payments API to update
        console.log(`Calling Dodo API: ${DODO_API_BASE}/subscriptions/${subscriptionId}`);
        const response = await fetch(
            `${DODO_API_BASE}/subscriptions/${subscriptionId}`,
            {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${DODO_PAYMENTS_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ cancel_at_next_billing_date: !autoRenew }),
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            console.error("Dodo Update Error:", response.status, errText);
            return res
                .status(response.status)
                .json({ error: `Failed to update Dodo subscription: ${errText}` });
        }

        console.log("Dodo API update successful");

        // 2. Update Supabase profile
        const { error } = await supabase
            .from("profiles")
            .update({ auto_renew: autoRenew })
            .eq("id", userId);

        if (error) throw error;

        console.log("Supabase profile updated successfully");

        return res.json({ success: true, autoRenew });
    } catch (err) {
        console.error("Toggle auto-renew error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
