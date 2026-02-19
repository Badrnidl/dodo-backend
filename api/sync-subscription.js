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
        // 1. Get the user's email from Supabase Auth
        const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);

        if (userError || !userData?.user) {
            console.error("User not found:", userError);
            return res.status(404).json({ error: "User not found in Auth" });
        }

        const userEmail = userData.user.email;
        console.log(`Syncing subscription for user ${userId} (${userEmail})`);

        // 2. Search for subscriptions in Dodo Payments
        // List subscriptions and find one matching this user's email
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
        console.log(`Found ${subscriptions.length || 0} subscriptions from Dodo`);

        // Find active subscription for this user's email
        // Subscriptions may be in an array or in a .items array
        const subsList = Array.isArray(subscriptions) ? subscriptions : (subscriptions.items || []);

        let matchedSub = null;
        for (const sub of subsList) {
            const subEmail = sub.customer?.email || sub.email;
            const subStatus = sub.status;

            if (
                subEmail &&
                subEmail.trim().toLowerCase() === userEmail.trim().toLowerCase() &&
                subStatus !== "cancelled"
            ) {
                matchedSub = sub;
                break;
            }
        }

        // Also try matching by metadata userId
        if (!matchedSub) {
            for (const sub of subsList) {
                const meta = sub.metadata || {};
                if (
                    (meta.userId === userId || meta.user_id === userId) &&
                    sub.status !== "cancelled"
                ) {
                    matchedSub = sub;
                    break;
                }
            }
        }

        if (!matchedSub) {
            console.log(`No active Dodo subscription found for email: ${userEmail}`);
            return res.status(404).json({
                error: "No active subscription found",
                hint: "No Dodo subscription matches your email. If you recently subscribed, please wait a few minutes and try again."
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
