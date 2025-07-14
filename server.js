const express = require('express');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws'); 
const XLSX = require('xlsx');
const app = express();
const PORT = 3000;

// --- Directory Definitions ---
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
const BOT_SESSION_PATH = path.resolve(__dirname, 'serverData');
const BLASTER_SESSION_PATH = path.resolve(__dirname, 'serverData');

// Define a single shared cache folder, used only by the bot now
const SHARED_CACHE_FOLDER = path.resolve(__dirname, '.wwebjs_cache');
const BOT_CACHE_FOLDER = SHARED_CACHE_FOLDER;

// --- Utility: Clear & Recreate Any Directory ---
/**
 * Wipes out a directory (if it exists) and then recreates it.
 * @param {string} dirPath – absolute path
 * @param {function} logger – function({type:'log'|'error', message}) to broadcast
 * @returns {{status:'success'|'error', message:string}}
 */
function clearAndRecreateDirectory(dirPath, logger) {
  try {
    logger({ type: 'log', message: `Clearing directory: ${dirPath}` });
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      logger({ type: 'log', message: `Deleted: ${dirPath}` });
    } else {
      logger({ type: 'log', message: `Not found (skipping delete): ${dirPath}` });
    }
    fs.mkdirSync(dirPath, { recursive: true });
    logger({ type: 'log', message: `Recreated: ${dirPath}` });
    return { status: 'success', message: `Directory reset: ${dirPath}` };
  } catch (err) {
    logger({ type: 'error', message: `Failed to reset ${dirPath}: ${err.message}` });
    return { status: 'error', message: err.message };
  }
}

// --- Modify multer setup to handle blaster image uploads ---
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync(UPLOAD_DIR)) {
                fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            }
            cb(null, UPLOAD_DIR);
        },
        filename: (req, file, cb) => {
            if (file.fieldname === 'messagesFile') {
                cb(null, 'messages.xlsx');
            } else if (file.fieldname === 'blastImage') {
                // Use a timestamp to avoid name conflicts for uploaded images
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
            } else {
                cb(null, file.originalname);
            }
        }
    })
});

// --- Child Process Variable ---
let botProcess = null;
let blasterProcess = null;

// --- WebSocket Server for Bot Logs ---
const wssBot = new WebSocket.Server({ noServer: true });
const wssBlaster = new WebSocket.Server({ noServer: true });

// --- Express Middleware ---
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(express.json()); 

// --- HTTP Server Initialization ---
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Ensure all necessary directories exist on server startup
    [UPLOAD_DIR, BOT_SESSION_PATH, BLASTER_SESSION_PATH, SHARED_CACHE_FOLDER].forEach(dir => { // Only bot-related paths
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    });
});

// --- WebSocket Upgrade Handling ---
server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    if (pathname === '/bot-logs') {
        wssBot.handleUpgrade(request, socket, head, (ws) => {
            wssBot.emit('connection', ws, request);
        });
    } else if (pathname === '/blaster-logs') { // ADD THIS BLOCK
        wssBlaster.handleUpgrade(request, socket, head, (ws) => {
            wssBlaster.emit('connection', ws, request);
            console.log('Blaster WebSocket client connected.');
        });
    } else {
        socket.destroy();
    }
});

// --- WebSocket Broadcast Function for Bot & Blaster Logs ---
function broadcastBotLog(data) { 
    wssBot.clients.forEach(client => { // <-- This was incomplete
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastBlasterLog(data) {
    wssBlaster.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- Helper to set up listeners for child processes ---
function setupChildProcessListeners(childProc, logPrefix, broadcastFunc, processType) {
    let buffer = '';

    childProc.stdout.on('data', (data) => {
        buffer += data.toString();

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);

            if (line.length === 0) {
                continue;
            }

            try {
                const parsed = JSON.parse(line);
                if (parsed.message) {
                    parsed.message = `[${logPrefix}] ${parsed.message}`;
                } else {
                    parsed.message = `[${logPrefix}] ${line}`;
                    parsed.type = parsed.type || 'log';
                }
                broadcastFunc(parsed);
            } catch (e) {
                broadcastFunc({ type: 'log', message: `[${logPrefix} RAW] ${line}` });
            }
        }
    });

    childProc.stderr.on('data', (data) => {
        const message = data.toString().trim();
        broadcastFunc({ type: 'error', message: `[${logPrefix} ERROR] ${message}` });
    });

    childProc.on('error', (err) => {
        broadcastFunc({ type: 'error', message: `[${logPrefix} PROCESS ERROR] Failed to start: ${err.message}` });
        // Correctly use processType to clear the relevant process variable
        if (processType === 'bot') {
            botProcess = null;
            console.log('[BOT PROCESS] Cleared on error');
        }
        // FIX #1: This was incorrectly clearing botProcess instead of blasterProcess
        if (processType === 'blaster') {
            blasterProcess = null; 
            console.log('[BLASTER PROCESS] Cleared on error');
        }
    });


    childProc.on('exit', (code, signal) => {
        // For debugging
        console.log(`[${logPrefix} PROCESS] Cleared ${processType} process variable.`);

        const exitMessage = `[${logPrefix} PROCESS] Exited with code ${code || 'null'} (Signal: ${signal || 'null'})`;
        broadcastFunc({ type: 'log', message: exitMessage });
        // Correctly use processType to clear the relevant process variable
        if (processType === 'bot') botProcess = null;
        if (processType === 'blaster') blasterProcess = null;
        broadcastFunc({ type: 'status', message: 'OFFLINE' });
    });

    childProc.on('message', (msg) => {
        const broadcastData = {
            ...msg,
            message: `[${logPrefix}] ${msg.message || ''}`
        };
        broadcastFunc(broadcastData);
    });
}

// --- General WA Endpoints ---
app.post('/clear-uploads', (req, res) => {
  // Broadcast to both interfaces
  const broadcastToBoth = (data) => {
    broadcastBotLog(data);
    broadcastBlasterLog(data);
  };

  const result = clearAndRecreateDirectory(UPLOAD_DIR, broadcastToBoth);

  if (result.status === 'success') {
    return res.json(result);
  } else {
    return res.status(500).json(result);
  }
});

function waitForExit(childProc) {
    return new Promise(resolve => {
        childProc.once('exit', resolve);
    });
}

// --- WA-Bot Endpoints ---
app.post('/bot/upload', upload.single('messagesFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
        fs.unlinkSync(req.file.path); 
        return res.status(400).json({ status: 'error', message: 'Only .xlsx files are allowed' });
    }

    broadcastBotLog({ type: 'log', message: `File uploaded: ${req.file.originalname}` }); 
    res.json({ status: 'success', filename: req.file.originalname });
});

app.post('/bot/start', (req, res) => {
    const { sessionMode, whitelist } = req.body; 
    console.log(`Received Bot start request: sessionMode=${sessionMode}, whitelist=${whitelist}`);

    const xlsxFiles = fs.readdirSync(UPLOAD_DIR).filter(file => 
        path.extname(file).toLowerCase() === '.xlsx'
    );

    if (xlsxFiles.length === 0) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Please upload an .xlsx file (messages.xlsx) before starting the bot.' 
        });
    }

    if (botProcess) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Bot is already running.' 
        });
    }

    try {
        botProcess = spawn('node', [
            path.join(__dirname, 'services', 'bot', 'index.js'), 
            sessionMode,
            whitelist
        ], {
            cwd: __dirname, 
            env: {
                ...process.env, 
                UPLOAD_DIR: UPLOAD_DIR, 
                BOT_SESSION_PATH: BOT_SESSION_PATH, 
                CACHE_FOLDER: BOT_CACHE_FOLDER 
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'] // CRITICAL: Enable IPC for botProcess
        });

        // FIX #2: The 'processType' argument was missing here.
        // Without it, the 'on.exit' handler didn't know to clear the botProcess variable.
        setupChildProcessListeners(botProcess, 'BOT', broadcastBotLog, 'bot'); 

        res.json({ status: 'success', message: `Bot start command sent successfully for ${sessionMode} session.` });
    } catch (err) {
        broadcastBotLog({ type: 'error', message: `Error starting bot: ${err.message}` }); 
        res.status(500).json({ status: 'error', message: 'Failed to start bot' });
    }
});

app.post('/bot/stop', async (req, res) => {
    if (!botProcess) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Bot is not running.' 
        });
    }

    try {
        botProcess.kill('SIGTERM');
        await waitForExit(botProcess); // Wait until it's truly dead
        res.json({ status: 'success', message: 'Bot stop command sent and process exited.' });
    } catch (err) {
        broadcastBotLog({ type: 'error', message: `Error stopping bot: ${err.message}` }); 
        res.status(500).json({ status: 'error', message: 'Failed to stop bot.' });
    }
});

app.get('/bot/status', (req, res) => {
    if (!botProcess) {
        return res.json({ status: 'offline' });
    }

    try {
        process.kill(botProcess.pid, 0); // Does not kill; just checks existence
        return res.json({ status: 'online', pid: botProcess.pid });
    } catch (e) {
        botProcess = null; // Clean up zombie
        return res.json({ status: 'offline (cleaned)' });
    }
});

app.get('/bot/export-contacts', (req, res) => {
    const dbFilePath = path.join(__dirname, 'uploads', 'contacts.json');

    if (!fs.existsSync(dbFilePath)) {
        return res.status(404).json({ status: 'error', message: 'contacts.json not found.' });
    }

    try {
        const dbData = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
        
        // Transform the data into a flat array of objects for Excel
        const formattedData = Object.keys(dbData).map(contactId => {
            const contact = dbData[contactId];
            return {
                'ContactID': contactId,
                'LastUpdated': contact.lastUpdated,
                'CurrentOption': contact.option,
                'LastMessage': contact.lastMessage,
                'Flags': contact.flags ? Object.keys(contact.flags).join(', ') : ''
            };
        });

        if (formattedData.length === 0) {
            return res.status(404).json({ status: 'error', message: 'No contacts to export.'});
        }

        // Create a new workbook and a worksheet
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(formattedData);

        // Append the worksheet to the workbook
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

        // Generate a buffer
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        // Set headers to trigger a download
        res.setHeader('Content-Disposition', 'attachment; filename="contacts-export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

        console.log('Contacts data exported successfully.');

    } catch (error) {
        console.error('Error exporting contacts:', error);
        res.status(500).json({ status: 'error', message: 'Failed to export contacts.' });
    }
});

// --- Add New Endpoints for WA-Blaster at the end of the file ---
app.post('/blaster/start', (req, res) => {
    if (blasterProcess) {
        return res.status(400).json({ status: 'error', message: 'Blaster is already running.' });
    }
    const { sessionMode } = req.body;
    try {
        blasterProcess = spawn('node', [
            path.join(__dirname, 'services', 'blaster', 'index.js'),
            sessionMode
        ], {
            cwd: __dirname,
            env: {
                ...process.env,
                BLASTER_SESSION_PATH: BLASTER_SESSION_PATH,
                CACHE_FOLDER: SHARED_CACHE_FOLDER,
                UPLOAD_DIR: UPLOAD_DIR
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });
        
        // Pass 'blaster' as the processType
        setupChildProcessListeners(blasterProcess, 'BLASTER', broadcastBlasterLog, 'blaster');
        
        res.json({ status: 'success', message: 'Blaster start command sent.' });
    } catch (err) {
        broadcastBlasterLog({ type: 'error', message: `Error starting blaster: ${err.message}` });
        res.status(500).json({ status: 'error', message: 'Failed to start blaster process.' });
    }
});

app.post('/blaster/stop', async (req, res) => {
    if (!blasterProcess) {
        return res.status(400).json({ status: 'error', message: 'Blaster is not running.' });
    }

    try {
        blasterProcess.kill('SIGTERM');
        console.log('[BLASTER] Sent SIGTERM');
        await waitForExit(blasterProcess); // wait for process to actually exit
        res.json({ status: 'success', message: 'Blaster stop command sent and process exited.' });
    } catch (err) {
        broadcastBlasterLog({ type: 'error', message: `Error stopping blaster: ${err.message}` });
        res.status(500).json({ status: 'error', message: 'Failed to stop blaster.' });
    }
});

// Use upload.single for the image file
app.post('/blaster/send', upload.single('blastImage'), (req, res) => {
    if (!blasterProcess) {
        return res.status(400).json({ status: 'error', message: 'Blaster is not running or ready.' });
    }
    
    const { contacts, message } = req.body;
    const imagePath = req.file ? req.file.filename : null; // Get filename if image was uploaded

    if (!contacts || !JSON.parse(contacts).length) {
        return res.status(400).json({ status: 'error', message: 'No contacts provided.' });
    }

    const blastData = {
        type: 'sendMessageBlast',
        contacts: JSON.parse(contacts),
        message: message || '',
        imagePath: imagePath
    };
    
    // Send command to the running blaster process via IPC
    blasterProcess.send(JSON.stringify(blastData));
    
    res.json({ status: 'success', message: 'Blast command sent to the blaster.' });
});

app.get('/blaster/status', (req, res) => {
    if (!blasterProcess) {
        return res.json({ status: 'offline' });
    }

    try {
        process.kill(blasterProcess.pid, 0); // ping without killing
        return res.json({ status: 'online', pid: blasterProcess.pid });
    } catch (e) {
        blasterProcess = null;
        return res.json({ status: 'offline (cleaned)' });
    }
});