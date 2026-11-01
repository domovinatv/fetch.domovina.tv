/**
 * Zajedničko za enqueue_all_new.js i all_episodes_report.js: kvota Claude pretplate
 * (api/oauth/usage, token iz Keychaina, zapis `-a ms` — drugi zapis istog imena ima
 * samo mcpOAuth) i INGEST ključ iz .env.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function loadEnvKey(repo, name = 'PIPELINE_QUEUE_INGEST_KEY') {
    if (process.env[name]) return process.env[name];
    try {
        const m = fs.readFileSync(path.join(repo, '.env'), 'utf8').match(new RegExp(`^${name}="?([^"\\n]+)`, 'm'));
        return m ? m[1] : null;
    } catch { return null; }
}

async function readUsage() {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'ms', '-w'],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const token = JSON.parse(raw).claudeAiOauth.accessToken;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`usage HTTP ${res.status}`);
    const j = await res.json();
    return {
        five_hour: j.five_hour.utilization,
        five_hour_resets_at: j.five_hour.resets_at,
        seven_day: j.seven_day.utilization,
        seven_day_resets_at: j.seven_day.resets_at,
    };
}

module.exports = { loadEnvKey, readUsage };
