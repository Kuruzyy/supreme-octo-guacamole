const fs = require('fs');
const path = require('path');

// ⚙️ Define the target directory and ensure it exists
const uploadsDir = process.env.UPLOAD_DIR;
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 📂 Point the database file path to the uploads directory
const dbFilePath = path.join(uploadsDir, 'contacts.json');
let db = {};

// Load existing database if it exists
try {
  if (fs.existsSync(dbFilePath)) {
    db = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
  }
} catch (err) {
  console.error('❌ Error loading contact DB:', err);
}

function saveDb() {
  // ✅ No changes needed here, it uses the corrected dbFilePath
  fs.writeFileSync(dbFilePath, JSON.stringify(db, null, 2));
}

function getContact(id) {
  return db[id] || null;
}

function upsertContact(id, lastMessage, option) {
  if (!db[id]) db[id] = {};
  db[id].lastMessage = lastMessage;
  db[id].option = option;
  db[id].lastUpdated = new Date().toISOString();
  saveDb();
}

function setFlag(id, flagKey) {
  if (!db[id]) db[id] = {};
  if (!db[id].flags) db[id].flags = {};
  db[id].flags[flagKey] = true;
  saveDb();
}

function resetContact(id) {
  if (db[id]) {
    db[id].option = 0;
    db[id].lastMessage = '';
    saveDb();
  }
}

module.exports = {
  getContact,
  upsertContact,
  setFlag,
  resetContact
};