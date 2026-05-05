const express = require('express');
const { Log } = require('logging-middleware');

const app = express();
const PORT = 3001;
const DEPOTS_API_URL = "http://20.207.122.201/evaluation-service/depots";
const VEHICLES_API_URL = "http://20.207.122.201/evaluation-service/vehicles";

app.use(express.json());

function knapsack(vehicles, maxHours) {
    const n = vehicles.length;
    const dp = Array(n + 1).fill(0).map(() => Array(maxHours + 1).fill(0));

    for (let i = 1; i <= n; i++) {
        const duration = vehicles[i - 1].Duration;
        const impact = vehicles[i - 1].Impact;

        for (let w = 1; w <= maxHours; w++) {
            if (duration <= w) {
                dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - duration] + impact);
            } else {
                dp[i][w] = dp[i - 1][w];
            }
        }
    }

    let res = dp[n][maxHours];
    let w = maxHours;
    const selected = [];

    for (let i = n; i > 0 && res > 0; i--) {
        if (res !== dp[i - 1][w]) {
            selected.push(vehicles[i - 1]);
            res -= vehicles[i - 1].Impact;
            w -= vehicles[i - 1].Duration;
        }
    }

    return {
        maxImpactScore: dp[n][maxHours],
        selectedVehicles: selected.reverse()
    };
}

app.get('/api/schedule/:depotId', async (req, res) => {
    try {
        const depotId = parseInt(req.params.depotId, 10);
        const token = process.env.AUTH_TOKEN;

        if (!token) {
            await Log("backend", "error", "handler", "Missing AUTH_TOKEN");
            return res.status(500).json({ error: "Missing AUTH_TOKEN in environment" });
        }

        const headers = { 'Authorization': `Bearer ${token}` };

        const depotRes = await fetch(DEPOTS_API_URL, { headers });
        if (!depotRes.ok) {
            await Log("backend", "error", "handler", "Failed to fetch depots");
            return res.status(500).json({ error: "Failed to fetch depots" });
        }
        const depotData = await depotRes.json();
        const depots = depotData.depots || [];
        const depot = depots.find(d => d.ID === depotId);

        if (!depot) {
            return res.status(404).json({ error: `Depot ID ${depotId} not found` });
        }

        const mechanicHours = depot.MechanicHours;
        await Log("backend", "info", "handler", `Depot ${depotId} has ${mechanicHours} mechanic hours`);

        const vehicleRes = await fetch(VEHICLES_API_URL, { headers });
        if (!vehicleRes.ok) {
            await Log("backend", "error", "handler", "Failed to fetch vehicles");
            return res.status(500).json({ error: "Failed to fetch vehicles" });
        }
        const vehicleData = await vehicleRes.json();
        const vehicles = vehicleData.vehicles || [];

        await Log("backend", "info", "handler", `Fetched ${vehicles.length} vehicles for scheduling`);

        const result = knapsack(vehicles, mechanicHours);

        const totalDuration = result.selectedVehicles.reduce((sum, v) => sum + v.Duration, 0);

        await Log("backend", "info", "handler", `Scheduled ${result.selectedVehicles.length} vehicles with max impact ${result.maxImpactScore}`);

        res.json({
            success: true,
            depotId: depotId,
            availableMechanicHours: mechanicHours,
            totalVehiclesEvaluated: vehicles.length,
            maxOperationalImpactScore: result.maxImpactScore,
            totalHoursUsed: totalDuration,
            selectedVehiclesCount: result.selectedVehicles.length,
            scheduledVehicles: result.selectedVehicles
        });

    } catch (error) {
        await Log("backend", "fatal", "handler", `Exception: ${error.message}`);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Vehicle Maintenance Scheduler running on port ${PORT}`);
});
