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
        console.log(`Found ${subsList.length} subscriptions from Dodo, searching for userId: ${userId}`);

        // 2. Search strategy: metadata userId first, then client_reference_id, then email as fallback
        let matchedSub = null;

        // Priority 1: Match by metadata userId (set during checkout)
        for (const sub of subsList) {
            const meta = sub.metadata || {};
            if (
                (meta.userId === userId || meta.user_id === userId) &&
                sub.status !== "cancelled"
            ) {
                matchedSub = sub;
                console.log(`Matched by metadata userId: ${sub.subscription_id || sub.id}`);
                break;
            }
        }

        // Priority 2: Match by client_reference_id (also set during checkout)
        if (!matchedSub) {
            for (const sub of subsList) {
                if (
                    sub.client_reference_id === userId &&
                    sub.status !== "cancelled"
                ) {
                    matchedSub = sub;
                    console.log(`Matched by client_reference_id: ${sub.subscription_id || sub.id}`);
                    break;
                }
            }
        }

        // Priority 3: Fall back to email matching (get email from Supabase)
        if (!matchedSub) {
            const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
            if (!userError && userData?.user?.email) {
                const userEmail = userData.user.email.trim().toLowerCase();
                for (const sub of subsList) {
                    const subEmail = (sub.customer?.email || sub.email || "").trim().toLowerCase();
                    if (subEmail && subEmail === userEmail && sub.status !== "cancelled") {
                        matchedSub = sub;
                        console.log(`Matched by email fallback: ${sub.subscription_id || sub.id}`);
                        break;
                    }
                }
            }
        }

        if (!matchedSub) {
            console.log(`No active Dodo subscription found for userId: ${userId}`);
            return res.status(404).json({
                error: "No active subscription found",
                hint: "No Dodo subscription matches your account. If you recently subscribed, please wait a few minutes and try again."
            });
        }

        const subscriptionId = matchedSub.subscription_id || matchedSub.id;
        const customerId = matchedSub.customer?.customer_id || matchedSub.customer?.id || null;
        const autoRenew = matchedSub.cancel_at_next_billing_date !== true;
        const nextBillingDate = matchedSub.next_billing_date || null;

        console.log(`Matched subscription: ${subscriptionId}, customer: ${customerId}, autoRenew: ${autoRenew}`);

        // 3. Update Supabase profile with subscription details
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
