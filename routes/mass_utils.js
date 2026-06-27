const express = require('express');
const router = express.Router();
const http = require('http');
const axios = require('axios');
const mass = require('./mass');
const { powerOffAllSpeakers } = require('./utils');

function dockerAction(action = 'restart') {
    return new Promise((resolve, reject) => {
        const containerName = process.env.MASS_CONTAINER_NAME;
        if (!containerName) return reject(new Error("MASS_CONTAINER_NAME not set in .env"));

        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/v1.41/containers/${containerName}/${action}`,
            method: 'POST',
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 204 || res.statusCode === 200) resolve(true);
            else reject(new Error(`Docker API Status: ${res.statusCode}`));
        });

        req.on('error', (err) => reject(err));
        req.end();
    });
}

// --- BULLETPROOF HEALTH CHECK ---
async function getMassHealth() {
    const massIp = process.env.MASS_IP;
    const massPort = process.env.MASS_PORT;

    if (!massIp || !massPort) {
        console.log(`[Boot] MASS Health Check Aborted: Missing Config in .env`);
        return { isOnline: false, version: "Unknown" };
    }

    try {
        // Use the explicitly documented unauthenticated /info endpoint
        const infoRes = await axios.get(`http://${massIp}:${massPort}/info`, { timeout: 3500 });
        
        let version = "Running";
        if (infoRes.data) {
            // Extract the version from the JSON response
            version = infoRes.data.server_version || infoRes.data.version || "Running";
        }

        return { isOnline: true, version: version };

    } catch (e) {
        // If we get an HTTP error like 403 or 401, the server is still technically online and responding!
        if (e.response) {
            return { isOnline: true, version: "2.x (Auth Required)" };
        }
        
        // A true network error means the Docker container is completely unreachable
        return { isOnline: false, version: "Offline" };
    }
}


// --- DYNAMIC PLAYER CONFIGURATION ENFORCER (WITH REGEX IP MATCH) ---
async function enforcePlayerConfigs(speakers) {
    const baseUrl = `http://${process.env.MASS_IP}:${process.env.MASS_PORT}`;
    console.log(`\n[Boot] ⏳ Waiting up to 60s for Music Assistant to discover speakers...`);

    try {
        const { data: { token } } = await axios.post(`${baseUrl}/auth/login`, {
            provider_id: "builtin",
            credentials: { username: process.env.MASS_USERNAME, password: process.env.MASS_PASSWORD }
        });
        const reqConfig = { headers: { 'Authorization': `Bearer ${token}` }, timeout: 5000 };

        // --- STAGE 1: Discovery Watchdog ---
        let massPlayers = [];
        let allDiscovered = false;
        
        for (let attempt = 1; attempt <= 12; attempt++) {
            const { data } = await axios.post(`${baseUrl}/api`, { command: "players/all", args: {} }, reqConfig).catch(() => ({ data: [] }));
            massPlayers = data || [];
            
            allDiscovered = speakers.every(speaker => 
                massPlayers.some(p => new RegExp(`\\b${speaker.ip.replace(/\./g, '\\.')}\\b`).test(JSON.stringify(p)))
            );

            if (allDiscovered) {
                console.log(`[Boot] ✅ All configured speakers discovered by MA network scan.`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        if (!allDiscovered) console.log(`[Boot] ⚠️ Discovery timeout. Auditing only available speakers.`);

        // Brief settle: MASS marks players discovered before protocol keys are fully hydrated.
        // Without this, config/players/get returns incomplete data for slow-to-respond speakers.
        console.log(`[MASS Utils] ⏳ Waiting 15s for MA to finish loading protocol configs...`);
        await new Promise(resolve => setTimeout(resolve, 15000));

        // --- STAGE 2: Core Configuration Audit ---
        console.log(`[MASS Utils] ⚙️ Auditing user-facing UI configurations...`);

        for (const speaker of speakers) {
            const ipRegex = new RegExp(`\\b${speaker.ip.replace(/\./g, '\\.')}\\b`);
            const player = massPlayers.find(p => ipRegex.test(JSON.stringify(p)));
            if (!player) continue;

            const configRes = await axios.post(`${baseUrl}/api`, { 
                command: "config/players/get", args: { player_id: player.player_id } 
            }, reqConfig).catch(() => null);

            if (!configRes?.data?.values) continue;
            const currentValues = configRes.data.values;
            
            const dlnaId = Object.keys(currentValues).find(k => k.startsWith('uuid:') && k.includes('||protocol||'))?.split('||')[0];
            const airplayId = Object.keys(currentValues).find(k => k.startsWith('ap') && k.includes('||protocol||'))?.split('||')[0];

            if (!dlnaId && !airplayId) {
                console.log(`[MASS Utils] ⏭️ ${player.name}: Protocols not yet populated by MA. Skipping — will enforce on next boot.`);
                continue;
            }

            const currentPref = currentValues['preferred_output_protocol']?.value || '';
            
            let activeMode;
            let activeId;

            // 1. If it's currently set to AirPlay, leave it alone
            if (airplayId && currentPref.includes(airplayId)) {
                activeMode = 'airplay';
                activeId = airplayId;
            } 
            // 2. If it's currently set to DLNA, leave it alone
            else if (dlnaId && currentPref.includes(dlnaId)) {
                activeMode = 'dlna';
                activeId = dlnaId;
            } 
            // 3. It's neither (e.g., 'Auto', blank, or bogus). Force it to DLNA.
            else {
                activeMode = 'dlna';
                activeId = dlnaId;
            }

            const targetConfigs = {
                "power_control": "none",
                "auto_play": false,
                "volume_normalization": false,
                "tts_pre_announce": false,
                "smart_fades_mode": "disabled",
                "volume_control": dlnaId,
                "mute_control":   dlnaId,
                "play_media_overrides_group": true,
                "preferred_output_protocol": activeId,
                [`${activeId}||protocol||enabled`]: true
            };

            let batchPayload = {};
            for (const [key, targetValue] of Object.entries(targetConfigs)) {
                if (targetValue !== undefined && (!currentValues[key] || currentValues[key].value !== targetValue)) {
                    batchPayload[key] = targetValue;
                }
            }

            if (Object.keys(batchPayload).length > 0) {
                console.log(`[MASS Utils] ⚠️ UI drift detected on ${player.name}. Pushing user-facing settings (${activeMode.toUpperCase()})...`);
                if (global.DEBUG_MODE) console.log(`[MASS Utils] 📦 Payload: ${JSON.stringify(batchPayload)}`);
                await axios.post(`${baseUrl}/api`, {
                    command: "config/players/save", args: { player_id: player.player_id, values: batchPayload }
                }, reqConfig);
            } else {
                console.log(`[MASS Utils] ⚡ ${player.name} (${activeMode.toUpperCase()}) user-facing config verified.`);
            }
        }
    } catch (e) {
        console.error(`[MASS Utils] ❌ Verification failed: ${e.response?.data || e.message}`);
    }
}



// POST /api/admin/restart_ma
router.post('/restart_ma', async (req, res) => {
    console.log(`\n-----------------------------------------------------------------------`);
    console.log(`[Admin] 🧹 Manual MASS restart requested via Web UI...`);
    console.log(`-----------------------------------------------------------------------`);
	
	// 🔥 EXECUTE UNIFIED SMART SHUTDOWN BEFORE KILLING DOCKER
    await powerOffAllSpeakers();
	
	
    
    // 1. Instantly release the UI so the frontend button doesn't freeze
    res.json({ success: true, message: "Restarting Music Assistant..." });

    try {
        await dockerAction('restart');
        if (mass && mass.resetHealth) mass.resetHealth();

        console.log(`[Admin] ⏳ Waiting for Music Assistant Docker container to boot...`);
        
        let massHealth = { isOnline: false };
        let attempts = 0;
        
        // 2. SMART POLLING USING YOUR HEALTH CHECK
        while (!massHealth.isOnline && attempts < 15) {
            await new Promise(r => setTimeout(r, 2000)); 
            massHealth = await getMassHealth();
            if (!massHealth.isOnline) {
                process.stdout.write('.'); // Print dots while waiting
                attempts++;
            }
        }
        if (attempts > 0) console.log(); // Clear the dots line

        // 3. CONFIRMATION & CONFIGURATION HEALING
        if (massHealth.isOnline) {
            console.log(`[Admin] ✅ Music Assistant is successfully back online (v${massHealth.version})!`);
            
            // We MUST re-run the configuration audit because MASS just lost its DB connections
            const fs = require('fs');
            const path = require('path');
            const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
            
            if (fs.existsSync(speakersPath)) {
                const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
                await enforcePlayerConfigs(SPEAKERS);
            }
        } else {
            console.log(`[Admin] ⚠️ MASS restart timeout. It may still be booting in the background.`);
        }
    } catch (err) {
        console.log(`[Admin] ❌ Failed to complete MASS restart sequence: ${err.message}`);
    }
});

router.post('/rescan_ma', async (req, res) => {
    try {
        const aggressive = req.body.aggressive || false;
        const provider = req.body.provider || 'dlna'; 

        if (aggressive) {
            console.log(`\n[Admin] 🚨 Triggering Aggressive MA Reload for: ${provider.toUpperCase()}`);
        } else {
            console.log(`\n[Admin] 🔄 Triggering MA Soft Rescan for: ${provider.toUpperCase()}...`);
        }
        
        const success = await mass.forceRescan(aggressive, provider);
        
        if (success) {
            res.json({ success: true, message: `Recovery command sent to Music Assistant (${provider})` });
        } else {
            res.status(500).json({ error: "Failed to communicate with MA API" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



module.exports = {
    router, 
    dockerAction,
    getMassHealth,
    enforcePlayerConfigs
};