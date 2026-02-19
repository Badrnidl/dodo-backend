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
