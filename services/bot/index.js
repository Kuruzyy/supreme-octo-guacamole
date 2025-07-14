// bot/index.js
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const { upsertContact, getContact, setFlag, resetContact } = require('./db');

// --- Configuration ---
const UPLOAD_DIR = process.env.UPLOAD_DIR
const BOT_SESSION_PATH = process.env.BOT_SESSION_PATH
const SHARED_CACHE_FOLDER = process.env.CACHE_FOLDER
const CONFIG_REFRESH_INTERVAL = 1 * 60 * 1000; // 5 minutes

// --- Globals ---
let client;
let messageConfigReloader;
let whitelistReloader;
let currentMessagesFile = null;

// --- IPC Communication ---
function sendToParent(type, data) {
    if (process.send) {
        process.send({ type, ...data });
    } else {
        const level = type.toUpperCase();
        console.log(`[BOT - ${level}]`, data.message || data);
    }
}

function log(message) { sendToParent('log', { message }); }
function errorLog(message) { sendToParent('error', { message }); }

// --- Utilities ---
function getLatestExcelFile() {
    try {
        if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            log(`Created upload directory: ${UPLOAD_DIR}`);
            return null;
        }
        const xlsxFiles = fs.readdirSync(UPLOAD_DIR)
            .filter(file => path.extname(file).toLowerCase() === '.xlsx')
            .sort((a, b) => {
                const statA = fs.statSync(path.join(UPLOAD_DIR, a));
                const statB = fs.statSync(path.join(UPLOAD_DIR, b));
                return statB.mtimeMs - statA.mtimeMs;
            });

        return xlsxFiles.length > 0 ? path.join(UPLOAD_DIR, xlsxFiles[0]) : null;
    } catch (err) {
        errorLog(`Error getting latest Excel file: ${err.message}`);
        return null;
    }
}

function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        log(`Deleted folder: ${folderPath}`);
    }
}

// --- Configuration Management ---
function createAutoRefreshConfig(sheetName = 'Flow') {
    let config = [];
    let lastModified = 0;
    let currentExcelPath = null;
    let intervalId = null;

    function load() {
        try {
            const newExcelPath = getLatestExcelFile();
            if (!newExcelPath) {
                if (config.length === 0) log('Waiting for an Excel file to be uploaded...');
                return config;
            }
            const fileStat = fs.statSync(newExcelPath);
            if (newExcelPath === currentExcelPath && fileStat.mtimeMs === lastModified) return config;

            log(`Reloading message config from ${path.basename(newExcelPath)}...`);
            const workbook = XLSX.readFile(newExcelPath);
            const sheet = workbook.Sheets[sheetName];
            if (!sheet) {
                errorLog(`Sheet "${sheetName}" not found in ${path.basename(newExcelPath)}.`);
                return config;
            }
            config = XLSX.utils.sheet_to_json(sheet);
            lastModified = fileStat.mtimeMs;
            currentExcelPath = newExcelPath;
            currentMessagesFile = path.basename(newExcelPath);
            log(`Message config reloaded: ${config.length} entries.`);
        } catch (error) {
            errorLog(`Error reloading message config: ${error.message}`);
        }
        return config;
    }

    load();
    intervalId = setInterval(load, CONFIG_REFRESH_INTERVAL);
    log(`Message config auto-refresh started (every ${CONFIG_REFRESH_INTERVAL / 60000} mins).`);

    return {
        getConfig: () => config,
        stop: () => {
            if (intervalId) {
                clearInterval(intervalId);
                log('Message config auto-refresh stopped.');
                intervalId = null;
            }
        },
    };
}

function createStaticWhitelist(initialNumbers) {
    let whitelist = initialNumbers || [];
    log(`Initial Whitelist loaded: ${whitelist.length} entries.`);
    return {
        getWhitelist: () => whitelist,
        setWhitelist: (newNumbers) => {
            whitelist = newNumbers;
            log(`Whitelist updated with ${newNumbers.length} entries.`);
        },
    };
}

// --- Core Bot Logic ---
async function startBot(sessionMode = 'continue', initialWhitelist = []) {
    log(`Initializing Bot in '${sessionMode}' mode...`);
    sendToParent('status', { message: 'INITIALIZING' });

    if (sessionMode === 'new') {
        log('New session requested. Cleaning up old session data...');
        deleteFolderRecursive(BOT_SESSION_PATH);
        deleteFolderRecursive(SHARED_CACHE_FOLDER);
    }

    [BOT_SESSION_PATH, SHARED_CACHE_FOLDER].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    messageConfigReloader = createAutoRefreshConfig();
    whitelistReloader = createStaticWhitelist(initialWhitelist);

    client = new Client({
        authStrategy: new LocalAuth({ clientId: 'wa-client', dataPath: BOT_SESSION_PATH }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu'
            ],
            timeout: 60000,
            cacheDirPath: SHARED_CACHE_FOLDER,
        },
        takeoverOnConflict: true,
        restartOnAuthFail: true,
    });

    client.on('qr', qr => {
        log('QR code received. Scan with your phone.');
        qrcode.generate(qr, { small: true });
        sendToParent('qr', { qrCode: qr });
    });

    client.on('ready', () => {
        log('✅ Bot Client is ready!');
        sendToParent('status', { message: 'READY' });
    });

    client.on('authenticated', () => log('Authenticated!'));
    client.on('auth_failure', msg => {
        errorLog(`Authentication failure: ${msg}`);
        sendToParent('status', { message: `AUTH_FAILED: ${msg}` });
    });

    client.on('disconnected', reason => {
        errorLog(`Client disconnected: ${reason}.`);
        sendToParent('status', { message: `DISCONNECTED: ${reason}` });
        if (client && client.initialized) {
            log('Attempting to re-initialize after disconnect...');
            client.initialize().catch(e => {
                errorLog(`Critical re-initialization failed: ${e.message}`);
                sendToParent('status', { message: `CRITICAL_REINIT_FAILED: ${e.message}` });
                process.exit(1);
            });
        }
    });

    client.on('message_create', handleMessage);

    try {
        await client.initialize();
        log('Bot client initialization requested.');
    } catch (err) {
        errorLog(`Failed to initialize Bot client: ${err.message}`);
        sendToParent('status', { message: `ERROR: ${err.message}` });
        await stopBot();
        process.exit(1);
    }
}

async function handleMessage(msg) {
    try {
        const from = msg.from;
        const bareNumber = from.replace('@c.us', '');
        const body = (msg.body || '').trim();
        const chat = await msg.getChat();

        if (chat.isGroup || from.endsWith('@newsletter')) return;

        const currentWhitelist = whitelistReloader.getWhitelist();
        if (currentWhitelist.length > 0 && !currentWhitelist.includes(bareNumber)) {
            log(`⛔ Blocked non-whitelisted number: ${bareNumber}`);
            return;
        }

        if (body.toLowerCase() === '/reset') {
            resetContact(from);
            if (chat.archived) await chat.unarchive();
            await client.sendMessage(from, '🔄 Your session has been reset. Please start again.');
            log(`Session reset for ${bareNumber}.`);
            return;
        }

        const contact = getContact(from);
        if (contact?.option === 'END') return;

        const currentConfig = messageConfigReloader.getConfig();
        const currentOption = parseInt(contact?.option || 0, 10);

        const match = findMatchingResponse(currentConfig, currentOption, body);

        if (!match) {
            log(`No matching trigger for ${bareNumber} at option ${currentOption}.`);
            return;
        }

        await processResponse(msg, match);
    } catch (err) {
        errorLog(`General message handling error for ${msg.from}: ${err.message}`);
        if (err.message.includes('Execution context was destroyed')) {
            errorLog('Browser context lost. Attempting to restart...');
            await restartBot();
        }
    }
}

function findMatchingResponse(config, option, body) {
    const specificMatch = config.find(row =>
        parseInt(row.Option, 10) === option &&
        (row.Trigger || '').toString().toLowerCase() === body.toLowerCase()
    );
    if (specificMatch) return specificMatch;

    const wildcardMatch = config.find(row =>
        parseInt(row.Option, 10) === option &&
        (row.Trigger || '').toString().trim() === '*'
    );
    return wildcardMatch;
}

async function processResponse(msg, match) {
    const { from } = msg;
    const bareNumber = from.replace('@c.us', '');
    const chat = await msg.getChat();

    log(`Match found for ${bareNumber} (Option: ${match.Option}, Trigger: "${match.Trigger}")`);

    if (match.Emoji) await msg.react(match.Emoji);

    if (match.MediaPath?.trim()) {
        const filePath = path.resolve(UPLOAD_DIR, match.MediaPath.trim());
        if (fs.existsSync(filePath)) {
            const media = MessageMedia.fromFilePath(filePath);
            const caption = (match.ResponseText || '').replace(/\|/g, '\n');
            await client.sendMessage(from, media, { caption });
            log(`Sent media to ${bareNumber}.`);
        } else {
            errorLog(`Media file not found: ${filePath}`);
            await client.sendMessage(from, `Error: Media file "${match.MediaPath.trim()}" not found.`);
        }
    } else if (match.ResponseText?.trim()) {
        const res = match.ResponseText.trim().replace(/\|/g, '\n');
        await client.sendMessage(from, res);
        log(`Sent response text to ${bareNumber}.`);
    }

    if (match.LogFile?.trim()) {
        setFlag(from, match.LogFile.trim());
        log(`Set flag "${match.LogFile.trim()}" for ${bareNumber}.`);
    }

    if ((match.Archive || '').toString().trim().toUpperCase() === 'YES') {
        if (!chat.archived) await chat.archive();
        log(`Archived chat with ${bareNumber}.`);
    }

    const nextOption = (match['Next Option']?.toString().trim().toUpperCase() === 'END') ? 'END' : parseInt(match['Next Option'] || '0', 10);
    upsertContact(from, msg.body, nextOption);
    log(`Updated contact ${bareNumber} to next option: ${nextOption}.`);
}

async function stopBot() {
    log('Stopping Bot...');
    sendToParent('status', { message: 'STOPPING' });
    if (messageConfigReloader) messageConfigReloader.stop();
    if (client) {
        try {
            await client.destroy();
            log('Bot client destroyed.');
        } catch (e) {
            errorLog(`Error destroying client: ${e.message}`);
        }
    }
    client = null;
    messageConfigReloader = null;
    whitelistReloader = null;
    log('Bot stopped and resources cleaned up.');
    sendToParent('status', { message: 'OFFLINE' });
}

async function restartBot() {
    await stopBot();
    log('Restarting Bot...');
    const sessionMode = process.argv[2] || 'continue';
    const whitelistArg = process.argv[3] || '';
    const initialWhitelist = whitelistArg.split(',').filter(Boolean);
    await startBot(sessionMode, initialWhitelist);
}

// --- Main Execution ---
async function main() {
    const sessionMode = process.argv[2] || 'continue';
    const whitelistArg = process.argv[3] || '';
    const initialWhitelist = whitelistArg.split(',').map(num => num.trim()).filter(Boolean);

    log(`Bot process started with mode: "${sessionMode}"`);
    if (initialWhitelist.length) log(`Initial Whitelist: ${initialWhitelist.join(', ')}`);

    await startBot(sessionMode, initialWhitelist);

    process.on('SIGINT', async () => {
        log('SIGINT received. Shutting down gracefully...');
        await stopBot();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        log('SIGTERM received. Shutting down gracefully...');
        await stopBot();
        process.exit(0);
    });

    process.on('uncaughtException', err => {
        errorLog(`Uncaught Exception: ${err.message}\n${err.stack}`);
        stopBot().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
        errorLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });

    process.on('exit', code => log(`Bot process exiting with code: ${code}`));
}

// --- Exports and Direct Execution ---
module.exports = {
    start: main,
    stop: stopBot,
    updateWhitelist: (newWhitelist) => {
        if (whitelistReloader) {
            whitelistReloader.setWhitelist(newWhitelist);
        } else {
            errorLog('Cannot update whitelist: reloader not initialized.');
        }
    },
};

if (require.main === module) {
    main();
}