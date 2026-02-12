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

    const { userId, subscriptionId } = req.body;

    if (!userId || !subscriptionId) {
        return res.status(400).json({ error: "Missing userId or subscriptionId" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // 1. Verify user owns this subscription
        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("subscription_id")
            .eq("id", userId)
            .single();

        if (profileError || !profile || profile.subscription_id !== subscriptionId) {
            return res.status(403).json({ error: "Invalid subscription for this user" });
        }

        // 2. Call Dodo Payments API to cancel
        if (DODO_PAYMENTS_API_KEY) {
            const response = await fetch(
                `${DODO_API_BASE}/subscriptions/${subscriptionId}`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${DODO_PAYMENTS_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ status: "cancelled" }),
                }
            );

            if (!response.ok) {
                const errText = await response.text();
                console.error("Dodo Cancel Error:", errText);
                return res
                    .status(response.status)
                    .json({ error: "Failed to cancel with payment provider" });
            }
        }

        // 3. Update Supabase profile
        const { error } = await supabase
            .from("profiles")
            .update({
                auto_renew: false,
                plan: "free",
                trial_expires_at: null,
            })
            .eq("subscription_id", subscriptionId);

        if (error) throw error;

        return res.json({ success: true, message: "Subscription cancelled" });
    } catch (err) {
        console.error("Cancel error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
