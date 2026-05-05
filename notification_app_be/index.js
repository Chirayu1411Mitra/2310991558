const express = require('express');
const { Log } = require('logging-middleware');

const app = express();
const PORT = 3000;
const NOTIFICATIONS_API_URL = "http://20.207.122.201/evaluation-service/notifications";

app.use(express.json());

const getTypeWeight = (type) => {
    const t = type.toLowerCase();
    if (t === 'placement') return 3;
    if (t === 'result') return 2;
    if (t === 'event') return 1;
    return 0;
};

app.get('/api/priority-inbox', async (req, res) => {
    try {
        const token = process.env.AUTH_TOKEN;
        if (!token) {
            await Log("backend", "error", "handler", "Missing AUTH_TOKEN environment variable");
            return res.status(500).json({ error: "Missing AUTH_TOKEN in environment" });
        }

        const response = await fetch(NOTIFICATIONS_API_URL, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            await Log("backend", "error", "handler", `Failed to fetch from evaluation service: ${response.status}`);
            return res.status(response.status).json({ error: "Failed to fetch notifications" });
        }

        const data = await response.json();
        const notifications = data.notifications || [];

        notifications.sort((a, b) => {
            const weightA = getTypeWeight(a.Type);
            const weightB = getTypeWeight(b.Type);

            if (weightA !== weightB) {
                return weightB - weightA; 
            }

            const timeA = new Date(a.Timestamp).getTime();
            const timeB = new Date(b.Timestamp).getTime();
            return timeB - timeA;
        });

        const top10 = notifications.slice(0, 10);

        await Log("backend", "info", "handler", "Successfully fetched and prioritized top 10 notifications");

        res.json({
            success: true,
            count: top10.length,
            priorityInbox: top10
        });

    } catch (error) {
        await Log("backend", "fatal", "handler", `Exception in priority inbox: ${error.message}`);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Notification Backend Server running on port ${PORT}`);
    // Optional: Log server startup
    // Log("backend", "info", "service", `Server started on port ${PORT}`).catch(() => {});
});
