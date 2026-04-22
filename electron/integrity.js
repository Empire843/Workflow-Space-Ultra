const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This will be replaced by the compile-bytecode script before obfuscation
const EXPECTED_HASHES = {
  "main.js": "0ab8fba8316dc31a719290b1517d264c3b2ebbb5a3df0b91fcaff1ee4856295e",
  "preload.js": "89d61734571c4ba140275fa4363a82b52acf46d34e691533e481b3ebfb5d9d16"
};

function checkIntegrity() {
  if (Object.keys(EXPECTED_HASHES).length === 0) {
    return true; // dev mode
  }

  const projectRoot = path.join(__dirname, '..');
  
  for (const [filename, expectedHash] of Object.entries(EXPECTED_HASHES)) {
    try {
      const filePath = path.join(__dirname, filename);
        
      const fileBuffer = fs.readFileSync(filePath);
      const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      
      if (actualHash !== expectedHash) {
        console.error(`[Integrity] Hash mismatch for ${filename}`);
        return false;
      }
    } catch (e) {
      console.error(`[Integrity] Error checking ${filename}:`, e);
      return false; // File missing or unreadable
    }
  }

  return true;
}

module.exports = { checkIntegrity };
