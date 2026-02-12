const { createClient } = require("@supabase/supabase-js");

// Events that upgrade/keep premium
const UPGRADE_EVENTS = [
    "payment.succeeded",
    "subscription.created",
    "subscription.updated",
    "subscription.renewed",
];

// Events that downgrade to free
const CANCEL_EVENTS = ["subscription.cancelled"];
const ALL_HANDLED = [...UPGRADE_EVENTS, ...CANCEL_EVENTS];

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

    // Validate env vars
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error("FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
        return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
    }

    const event = req.body;
    const eventType = event.type;
    const data = event.data;

    console.log(`Received webhook event: ${eventType}`);
    console.log(`Event payload keys: ${JSON.stringify(Object.keys(event))}`);

    // Ignore unhandled events
    if (!ALL_HANDLED.includes(eventType)) {
        console.log(`Ignoring event: ${eventType}`);
        return res.status(200).json({ received: true, ignored: eventType });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
        const subscriptionId =
            data?.subscription_id || data?.subscription?.subscription_id;

        // --- Handle cancellation ---
        if (CANCEL_EVENTS.includes(eventType)) {
            console.log(`Processing cancellation for subscription: ${subscriptionId}`);

            if (!subscriptionId) {
                return res.status(400).json({ error: "No subscription_id in cancellation event" });
            }

            const { error } = await supabase
                .from("profiles")
                .update({
                    plan: "free",
                    auto_renew: false,
                    trial_expires_at: null,
                })
                .eq("subscription_id", subscriptionId);

            if (error) {
                console.error("Cancel error:", error);
                return res.status(500).json({ error: "Failed to cancel" });
            }

            console.log(`Subscription ${subscriptionId} cancelled`);
            return res.status(200).json({ success: true, message: "Subscription cancelled" });
        }

        // --- Handle upgrade/renewal events ---
        const customerEmail = data?.customer?.email;
        if (!customerEmail) {
            console.error("No customer email in payload. Full data:", JSON.stringify(data));
            return res.status(400).json({ error: "No customer email" });
        }

        console.log(`Customer email: ${customerEmail}`);

        // Find user by email
        const {
            data: { users },
            error: listError,
        } = await supabase.auth.admin.listUsers();

        if (listError) {
            console.error("Failed to list users:", listError);
            return res.status(500).json({ error: "Failed to find user" });
        }

        const user = users.find(
            (u) => u.email?.toLowerCase() === customerEmail.toLowerCase()
        );

        if (!user) {
            console.error(`No user found for email: ${customerEmail}`);
            return res.status(404).json({ error: `No user found for email: ${customerEmail}` });
        }

        console.log(`Found user: ${user.id}`);

        // Build update data
        const updateData = {
            plan: "premium",
            trial_expires_at: null,
        };

        if (subscriptionId) {
            updateData.subscription_id = subscriptionId;
            updateData.auto_renew = true;
        }

        // For subscription.updated, check cancel_at_next_billing_date
        if (eventType === "subscription.updated") {
            if (data?.cancel_at_next_billing_date === true) {
                updateData.auto_renew = false;
            }
            if (data?.status === "cancelled") {
                updateData.plan = "free";
                updateData.auto_renew = false;
            }
        }

        // Sync next_billing_date
        if (
            eventType === "subscription.renewed" ||
            eventType === "subscription.updated"
        ) {
            if (data?.next_billing_date) {
                updateData.renews_at = data.next_billing_date;
            }
        }

        const { error: updateError } = await supabase
            .from("profiles")
            .update(updateData)
            .eq("id", user.id);

        if (updateError) {
            console.error("Update error:", updateError);
            return res.status(500).json({ error: "Failed to update profile" });
        }

        console.log(`User ${user.id} processed event: ${eventType}`);
        return res.status(200).json({ success: true, event: eventType, userId: user.id });
    } catch (err) {
        console.error("Webhook processing error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
