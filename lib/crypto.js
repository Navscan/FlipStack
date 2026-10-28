const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
// Fallback to empty string if undefined to prevent crash on boot
const hexKey = process.env.ENCRYPTION_KEY || '';
const KEY = Buffer.from(hexKey, 'hex');

if (KEY.length !== 32) {
    console.error('⚠️ WARNING: ENCRYPTION_KEY is missing or invalid in .env. Keys will be saved as plain text!');
}

/**
 * Encrypts a string using AES-256-GCM
 */
function encrypt(text) {
    if (!text) return text;
    if (KEY.length !== 32) return text; // Fallback if no key
    if (text.includes(':')) return text;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a string encrypted by the encrypt() function
 */
function decrypt(text) {
    if (!text) return text;
    if (KEY.length !== 32) return text; // Fallback if no key
    
    // If it doesn't have our separator, assume it's plain text (legacy key)
    if (!text.includes(':')) return text;

    try {
        const parts = text.split(':');
        if (parts.length !== 3) throw new Error('Invalid encrypted format');
        
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encryptedText = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        console.error('[CRYPTO ERROR] Failed to decrypt key:', error.message);
        return null;
    }
}

module.exports = { encrypt, decrypt };
