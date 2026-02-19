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
    const DODO_PAYMENTS_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
    const DODO_API_BASE = process.env.DODO_LIVE === "true"
        ? "https://live.dodopayments.com"
        : "https://test.dodopayments.com";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
    }

    if (!DODO_PAYMENTS_API_KEY) {
        return res.status(500).json({ error: "Server misconfigured: missing Dodo Payments API Key" });
    }

    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId parameter" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        // 1. Fetch all subscriptions from Dodo Payments
        const subsResponse = await fetch(
            `${DODO_API_BASE}/subscriptions`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${DODO_PAYMENTS_API_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!subsResponse.ok) {
            const errText = await subsResponse.text();
            console.error("Dodo API error:", subsResponse.status, errText);
            return res.status(500).json({ error: "Failed to fetch subscriptions from Dodo" });
        }

        const subscriptions = await subsResponse.json();
        const subsList = Array.isArray(subscriptions) ? subscriptions : (subscriptions.items || []);

        // Get only active subscriptions
        const activeSubs = subsList.filter(s => s.status !== "cancelled");
        console.log(`Found ${subsList.length} total, ${activeSubs.length} active Dodo subscriptions`);

        // 2. Search strategy: metadata userId first, then client_reference_id, then fallback to unlinked subscription
        let matchedSub = null;

        // Priority 1: Match by metadata userId (set during checkout)
        for (const sub of activeSubs) {
            const meta = sub.metadata || {};
            if (meta.userId === userId || meta.user_id === userId) {
                matchedSub = sub;
                console.log(`Matched by metadata userId: ${sub.subscription_id || sub.id}`);
                break;
            }
        }

        // Priority 2: Match by client_reference_id (also set during checkout)
        if (!matchedSub) {
            for (const sub of activeSubs) {
                if (sub.client_reference_id === userId) {
                    matchedSub = sub;
                    console.log(`Matched by client_reference_id: ${sub.subscription_id || sub.id}`);
                    break;
                }
            }
        }

        // Priority 3: Fall back to unlinked active subscription (for legacy/current cases)
        if (!matchedSub) {
            // Get all subscription_ids already linked in Supabase profiles
            const { data: linkedProfiles, error: profilesError } = await supabase
                .from("profiles")
                .select("subscription_id")
                .not("subscription_id", "is", null);

            if (profilesError) {
                console.error("Failed to fetch profiles:", profilesError);
                // Continue with best effort
            } else {
                const linkedSubIds = new Set(
                    (linkedProfiles || []).map(p => p.subscription_id).filter(Boolean)
                );
                console.log(`${linkedSubIds.size} subscriptions already linked to profiles`);

                // Find active Dodo subscriptions NOT linked to any profile
                const unlinkedSubs = activeSubs.filter(sub => {
                    const subId = sub.subscription_id || sub.id;
                    return !linkedSubIds.has(subId);
                });

                console.log(`${unlinkedSubs.length} unlinked active subscriptions found`);

                if (unlinkedSubs.length > 0) {
                    // Pick the most recent unlinked subscription (first in list = newest)
                    matchedSub = unlinkedSubs[0];
                    console.log(`Matched by unlinked fallback: ${matchedSub.subscription_id || matchedSub.id}`);
                }
            }
        }

        if (!matchedSub) {
            return res.status(404).json({
                error: "No matching subscription found",
                hint: "No Dodo subscription matches your account (metadata) and no unlinked subscriptions are available."
            });
        }

        const subscriptionId = matchedSub.subscription_id || matchedSub.id;
        const customerId = matchedSub.customer?.customer_id || matchedSub.customer?.id || null;
        const autoRenew = matchedSub.cancel_at_next_billing_date !== true;
        const nextBillingDate = matchedSub.next_billing_date || null;

        console.log(`Linking unlinked subscription ${subscriptionId} to user ${userId}`);

        // 5. Update Supabase profile with subscription details
        const updateData = {
            subscription_id: subscriptionId,
            plan: "premium",
            auto_renew: autoRenew,
            updated_at: new Date().toISOString(),
        };

        if (customerId) {
            updateData.customer_id = customerId;
        }
        if (nextBillingDate) {
            updateData.renews_at = nextBillingDate;
        }

        const { error: updateError } = await supabase
            .from("profiles")
            .update(updateData)
            .eq("id", userId);

        if (updateError) {
            console.error("Supabase update error:", updateError);
            return res.status(500).json({ error: "Failed to update profile" });
        }

        console.log(`Successfully synced subscription ${subscriptionId} for user ${userId}`);

        return res.status(200).json({
            success: true,
            subscriptionId,
            customerId,
            autoRenew,
            message: `Subscription ${subscriptionId} synced successfully`
        });
    } catch (err) {
        console.error("Sync subscription error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
