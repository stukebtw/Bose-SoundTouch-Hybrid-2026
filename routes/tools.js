// routes/tools.js — Backend for tools.html
const express = require('express');
const router = express.Router();
const net = require('net');
const fs = require('fs');
const path = require('path');
const { executeSmartShutdown, runSpeakerAudit, pushPresetsToSpeaker, updateWatchdogGlobals } = require('./utils');

const SETTINGS_FILE = path.join(process.cwd(), 'config', 'settings.json');

function getSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("[Tools] Error reading settings.json", e);
    }

    // Master Fallback Schema
    return {
        autoResumePreset: false,
        autoRestartMass: false,
        autoSyncVolume: false,
        mobileAutoSortSpeakers: true,
        scheduledSpeakerAudit: true,
        scheduledRestart: false,
        includeReboot: false,
        bypassCloudEmulation: false,
        presetWatchdogSpeakers: [],
        presetWatchdogIntervalMinutes: 60,
        presetWatchdogMode: 'push',
        searchMenuOrder: ['global', 'radio', 'nas']
    };
}

// --- SETTINGS API ---
router.get('/admin/settings', (req, res) => {
    res.json(getSettings());
});

router.post('/admin/settings', (req, res) => {
    try {
        const currentSettings = getSettings();
        const newSettings = { ...currentSettings, ...req.body };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 4));
        updateWatchdogGlobals();
        res.json({ success: true });
    } catch (e) {
        console.error("[Tools] Failed to save settings:", e);
        res.status(500).json({ error: "Failed to save settings.json" });
    }
});

// --- SYSTEM VERSIONS & TIMEZONE ---
router.get('/admin/system_versions', (req, res) => {
    try {
        res.json({
            app: global.APP_VERSION || "????",
            mass: global.MASS_VERSION || "????",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "????"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- TOGGLE VERBOSE DEBUG ---
router.post('/admin/toggle_debug', (req, res) => {
    global.DEBUG_MODE = req.body.debug === true;
    console.log(`[Tools] Verbose Debug Mode set to: ${global.DEBUG_MODE ? 'ON' : 'OFF'}`);
    res.send({ success: true, debug: global.DEBUG_MODE });
});

// --- GET CURRENT DEBUG STATE ---
router.get('/admin/debug_state', (req, res) => {
    res.json({ debug: global.DEBUG_MODE === true });
});

// --- APP RESTART ---
router.post('/admin/restart', async (req, res) => {
    const { injectTarget, rebootTarget } = req.body;
    try {
        await executeSmartShutdown(injectTarget, rebootTarget);
        res.status(200).json({ success: true });
    } catch (e) {
        console.error(`[Tools] Failed to execute manual system restart: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// --- MANUAL SPEAKER AUDIT TRIGGER ---
router.post('/admin/force_audit', async (req, res) => {
    try {
        console.log(`[Tools] 🛠️ Manual Speaker Audit triggered via API.`);
        runSpeakerAudit(); // Executes asynchronously in the background
        res.status(200).json({ success: true, message: "Audit initiated" });
    } catch (e) {
        console.error(`[Tools] Failed to trigger manual audit: ${e.message}`);
        res.status(500).json({ success: false });
    }
});

// --- PRESET WATCHDOG: MANUAL "PUSH NOW" ---
router.post('/admin/force_preset_push', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, error: "Missing speaker IP" });
    try {
        console.log(`[Tools] 🛠️ Manual Preset Push triggered via API for ${ip}.`);
        pushPresetsToSpeaker(ip); // Executes asynchronously in the background
        res.status(200).json({ success: true, message: "Preset push initiated" });
    } catch (e) {
        console.error(`[Tools] Failed to trigger manual preset push: ${e.message}`);
        res.status(500).json({ success: false });
    }
});

// ============================================================================
// ST10 STEREO PAIRING API (Configuration)
// ============================================================================
const stereoPairsFile = path.join(process.cwd(), 'config', 'stereo_pairs.json');

const getStereoPairs = () => {
    try {
        if (!fs.existsSync(stereoPairsFile)) return [];
        return JSON.parse(fs.readFileSync(stereoPairsFile, 'utf8'));
    } catch (err) {
        console.error(`[Tools] ❌ Error reading stereo pairs file:`, err.message);
        return [];
    }
};

const saveStereoPairs = (data) => {
    try {
        fs.writeFileSync(stereoPairsFile, JSON.stringify(data, null, 2));
        console.log(`[Tools] 💾 Successfully saved ${data.length} stereo pair(s) to disk.`);
    } catch (err) {
        console.error(`[Tools] ❌ Error writing stereo pairs file:`, err.message);
    }
};

router.get('/admin/stereo-pairs', (req, res) => {
    if (global.DEBUG_MODE) {
        console.log(`[Tools] 📥 Fetching active stereo pairs...`);
    }
    res.json(getStereoPairs());
});

router.post('/admin/stereo-pairs', (req, res) => {
    const { leftIp, rightIp, name } = req.body;
    console.log(`[Tools] ➕ Creating new stereo pair: "${name}" (L: ${leftIp} | R: ${rightIp})`);

    const pairs = getStereoPairs();
    const newPair = {
        id: Date.now().toString(),
        name,
        leftIp,
        rightIp,
        stereoXml: true
    };

    pairs.push(newPair);
    saveStereoPairs(pairs);
    res.json({ success: true, pair: newPair });
});

router.delete('/admin/stereo-pairs/:id', (req, res) => {
    console.log(`[Tools] 🗑️ Deleting stereo pair ID: ${req.params.id}`);
    let pairs = getStereoPairs();
    pairs = pairs.filter(p => p.id !== req.params.id);
    saveStereoPairs(pairs);
    res.json({ success: true });
});

// --- UNIFIED WI-FI PROVISIONING ---
router.post('/admin/set_wifi', async (req, res) => {
    const { ip, ssid, password } = req.body;
    console.log(`[Tools] Sending Wi-Fi Provisioning to ${ip}... (SSID: ${ssid})`);

    const isUsb = (ip === "203.0.113.1" || ip === "192.168.1.1");
    let hasResponded = false;
    const client = new net.Socket();

    client.on('error', (err) => {
        console.log(`[Tools] Telnet error on ${ip}: ${err.message}`);
        if (!hasResponded) {
            res.status(500).send({ error: `Telnet Error: ${err.message}` });
            hasResponded = true;
        }
    });

    if (isUsb) {
        // ==========================================
        // PATH A: USB CONNECTION (Verified)
        // ==========================================
        let outputBuffer = "";

        client.on('data', (data) => {
            outputBuffer += data.toString();

            // Wait until the speaker prints the </WiFiProfiles> closing tag
            if (outputBuffer.includes('</WiFiProfiles>')) {
                if (outputBuffer.includes(`SSID="${ssid}"`)) {
                    console.log(`[Tools] ✅ USB Setup Verified: Profile saved! Waiting for UI to trigger reboot...`);
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                } else {
                    console.log(`[Tools] ❌ USB Setup Failed: SSID not found in memory.`);
                    if (!hasResponded) {
                        res.status(500).send({ error: "Wi-Fi profile did not save to the speaker." });
                        hasResponded = true;
                    }
                }
                setTimeout(() => client.destroy(), 500);
            }
        });

        client.connect(17000, ip, () => {
            console.log(`[Tools] Connected to ${ip}:17000 (USB) - Pushing and Verifying...`);
            const tapCommands = `async_responses on\r\nnetwork wifi profiles clear\r\nnetwork wifi profiles add ${ssid} wpa_or_wpa2 ${password}\r\nnetwork wifi profiles info\r\n`;
            client.write(tapCommands);

            setTimeout(() => {
                if (!hasResponded) {
                    res.status(500).send({ error: "Verification timed out. Check speaker." });
                    hasResponded = true;
                    client.destroy();
                }
            }, 5000);
        });
    } else {
        // ==========================================
        // PATH B: NETWORK CONNECTION (Network Switch)
        // No 90s DLNA reload: speaker is switching Wi-Fi networks.
        // MASS will rediscover it naturally once it comes back on the new network.
        // ==========================================
        client.connect(17000, ip, () => {
            console.log(`[Tools] Connected to ${ip}:17000 (Network) - Executing Clean Wi-Fi Switch...`);

            // 1. Wipe the flash memory
            client.write('network wifi profiles clear\r\n');
            console.log(`[Tools] Sent 'clear'. Waiting 3 seconds...`);

            setTimeout(() => {
                // 2. Inject the new Wi-Fi credentials
                client.write(`network wifi profiles add "${ssid}" wpa_or_wpa2 "${password}"\r\n`);
                console.log(`[Tools] Sent 'add'. Waiting 12 seconds for NVRAM save...`);

                // 3. Reboot the speaker to apply changes
                setTimeout(() => {
                    client.write('sys reboot\r\n');
                    console.log(`[Tools] Sent 'reboot'. Closing connection.`);

                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                    setTimeout(() => client.destroy(), 500);
                }, 12000); // 12-second delay for saving

            }, 3000); // 3-second delay for clearing
        });
    }
});

module.exports = { router };
