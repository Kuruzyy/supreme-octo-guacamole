// blaster/index.js
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- Configuration ---
const UPLOAD_DIR = process.env.UPLOAD_DIR
const BLASTER_SESSION_PATH = process.env.BLASTER_SESSION_PATH
const SHARED_CACHE_FOLDER = process.env.CACHE_FOLDER

// --- Globals ---
let client = null;
let isClientReady = false;

// --- IPC Communication ---
function sendToParent(type, data) {
    if (process.send) {
        process.send({ type, ...data });
    } else {
        const level = type.toUpperCase();
        console.log(`[BLASTER - ${level}]`, data.message || data);
    }
}

function log(message) { sendToParent('log', { message }); }
function errorLog(message) { sendToParent('error', { message }); }

// --- Utilities ---
function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        log(`Deleted folder: ${folderPath}`);
    }
}

// --- Core Blaster Logic ---
async function startBlaster(sessionMode = 'continue') {
    log(`Initializing Blaster in '${sessionMode}' mode...`);
    sendToParent('status', { message: 'INITIALIZING' });

    if (sessionMode === 'new') {
        log('New session requested. Cleaning up old session data...');
        deleteFolderRecursive(BLASTER_SESSION_PATH);
        // Note: Shared cache is intentionally not cleared here.
    }

    [BLASTER_SESSION_PATH, SHARED_CACHE_FOLDER].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    client = new Client({
        authStrategy: new LocalAuth({ clientId: 'wa-client', dataPath: BLASTER_SESSION_PATH }),
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
        log('✅ Blaster Client is ready!');
        isClientReady = true;
        sendToParent('status', { message: 'READY' });
    });

    client.on('authenticated', () => log('Authenticated!'));
    client.on('auth_failure', msg => {
        errorLog(`Authentication failure: ${msg}`);
        sendToParent('status', { message: `AUTH_FAILED: ${msg}` });
    });

    client.on('disconnected', reason => {
        isClientReady = false;
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

    try {
        await client.initialize();
        log('Blaster client initialization requested.');
    } catch (err) {
        errorLog(`Failed to initialize Blaster client: ${err.message}`);
        sendToParent('status', { message: `ERROR: ${err.message}` });
        await stopBlaster();
        process.exit(1);
    }
}

async function deliverMessages({ contacts, message, imagePath }) {
    if (!isClientReady) {
        errorLog('Client not ready. Cannot send messages.');
        sendToParent('status', { message: 'ERROR: Client Not Connected' });
        return;
    }

    const validContacts = contacts
        .map(c => c.replace(/\D/g, ''))
        .filter(c => c.length >= 8 && c.length <= 15)
        .filter((c, i, arr) => arr.indexOf(c) === i);

    const skipped = contacts.length - validContacts.length;
    if (skipped > 0) log(`Skipped ${skipped} invalid or duplicate phone numbers.`);

    if (validContacts.length === 0) {
        errorLog('No valid contacts to send to.');
        sendToParent('status', { message: 'READY' });
        return;
    }

    log(`Starting delivery to ${validContacts.length} contacts...`);
    sendToParent('status', { message: `BLASTING (${validContacts.length} contacts)` });

    const media = imagePath ? MessageMedia.fromFilePath(path.resolve(UPLOAD_DIR, imagePath)) : null;
    const delayMs = 7000;

    for (const [index, contact] of validContacts.entries()) {
        try {
            const numberId = await client.getNumberId(contact);
            if (!numberId) {
                log(`${index + 1}/${validContacts.length} - ${contact}: Not a WhatsApp user.`);
                continue;
            }

            if (media) {
                await client.sendMessage(numberId._serialized, media, { caption: message });
                log(`${index + 1}/${validContacts.length} - ${contact}: Sent message with image.`);
            } else {
                await client.sendMessage(numberId._serialized, message);
                log(`${index + 1}/${validContacts.length} - ${contact}: Sent text message.`);
            }
        } catch (err) {
            errorLog(`Failed to send to ${contact}: ${err.message}`);
        }
        await new Promise(res => setTimeout(res, delayMs));
    }

    log('Message delivery finished.');
    sendToParent('status', { message: 'READY' });
}

async function stopBlaster() {
    log('Stopping Blaster...');
    sendToParent('status', { message: 'STOPPING' });
    if (client) {
        try {
            await client.destroy();
            log('Blaster client destroyed.');
        } catch (e) {
            errorLog(`Error destroying client: ${e.message}`);
        }
    }
    client = null;
    isClientReady = false;
    log('Blaster stopped and resources cleaned up.');
    sendToParent('status', { message: 'OFFLINE' });
}

// --- Main Execution ---
async function main() {
    const sessionMode = process.argv[2] || 'continue';
    log(`Blaster process started with mode: "${sessionMode}"`);

    await startBlaster(sessionMode);

    process.on('message', async (ipcMessage) => {
        try {
            const message = typeof ipcMessage === 'string' ? JSON.parse(ipcMessage) : ipcMessage;
            switch (message.type) {
                case 'sendMessageBlast':
                    log('Received "sendMessageBlast" command.');
                    await deliverMessages(message);
                    break;
                case 'stopBlaster':
                    log('Received "stopBlaster" command.');
                    await stopBlaster();
                    process.exit(0);
                    break;
                default:
                    log(`Received unknown IPC message type: ${message.type}`);
            }
        } catch (e) {
            errorLog(`Error processing IPC message: ${e.message}`);
        }
    });

    process.on('SIGINT', async () => {
        log('SIGINT received. Shutting down gracefully...');
        await stopBlaster();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        log('SIGTERM received. Shutting down gracefully...');
        await stopBlaster();
        process.exit(0);
    });

    process.on('uncaughtException', err => {
        errorLog(`Uncaught Exception: ${err.message}\n${err.stack}`);
        stopBlaster().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
        errorLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });

    process.on('exit', code => log(`Blaster process exiting with code: ${code}`));
}

if (require.main === module) {
    main();
}