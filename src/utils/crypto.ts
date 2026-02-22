import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-cbc';

// Derive a 32-byte key from JWT_SECRET
function getKey(): Buffer {
    return crypto.createHash('sha256').update(config.jwtSecret).digest();
}

export function encryptPassword(plainText: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

export function decryptPassword(encrypted: string): string {
    try {
        const [ivHex, data] = encrypted.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return '***';
    }
}
