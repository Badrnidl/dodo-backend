const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DODO_PAYMENTS_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
const DODO_API_BASE = process.env.DODO_LIVE === "true"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";

module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { userId, subscriptionId, autoRenew } = req.body;

    if (!userId || !subscriptionId || typeof autoRenew !== "boolean") {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // 1. Call Dodo Payments API to update
        if (DODO_PAYMENTS_API_KEY) {
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
                console.error("Dodo Update Error:", errText);
                return res
                    .status(response.status)
                    .json({ error: "Failed to update subscription settings" });
            }
        }

        // 2. Update Supabase profile
        const { error } = await supabase
            .from("profiles")
            .update({ auto_renew: autoRenew })
            .eq("id", userId);

        if (error) throw error;

        return res.json({ success: true, autoRenew });
    } catch (err) {
        console.error("Toggle auto-renew error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
