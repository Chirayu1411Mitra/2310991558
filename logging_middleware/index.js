const API_URL = "http://20.207.122.201/evaluation-service/logs";

const VALID_STACKS = ["backend", "frontend"];
const VALID_LEVELS = ["debug", "info", "warn", "error", "fatal"];

const VALID_BACKEND_PACKAGES = [
  "cache", "controller", "cron_job", "db", "domain", 
  "handler", "repository", "route", "service"
];

const VALID_FRONTEND_PACKAGES = [
  "api", "component", "hook", "page", "state", "style"
];

const VALID_COMMON_PACKAGES = [
  "auth", "config", "middleware", "utils"
];

async function Log(stack, level, pkg, message) {
    try {
        if (!VALID_STACKS.includes(stack)) {
            console.error(`Invalid stack: ${stack}`);
            return;
        }

        if (!VALID_LEVELS.includes(level)) {
            console.error(`Invalid level: ${level}`);
            return;
        }

        let isValidPackage = false;
        if (VALID_COMMON_PACKAGES.includes(pkg)) {
            isValidPackage = true;
        } else if (stack === "backend" && VALID_BACKEND_PACKAGES.includes(pkg)) {
            isValidPackage = true;
        } else if (stack === "frontend" && VALID_FRONTEND_PACKAGES.includes(pkg)) {
            isValidPackage = true;
        }

        if (!isValidPackage) {
            console.error(`Invalid package '${pkg}' for stack '${stack}'`);
            return;
        }

        const payload = { stack, level, package: pkg, message };
        const token = process.env.AUTH_TOKEN || "";

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error("Failed to send log. Status:", response.status);
        }
    } catch (error) {
        console.error("Exception sending log to evaluation service:", error.message);
    }
}

module.exports = { Log };
