import crypto from 'crypto';
import 'dotenv/config';

export class ChaChaPoly1305 {
  constructor() {
    const key = process.env.NODE_DB_ENCRYPTION_KEY;
    if (!key) {
      throw new Error('Client Database Encryption key is missing');
    }

    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('Key must be 32 bytes (base64 encoded)');
    }
  }
  /**
   * Encrypts data
   * @param {plaintext: string}
   * @returns { ciphertext: string, nonce: string, tag: string }
   */
  encrypt(plaintext) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('chacha20-poly1305', this.key, nonce);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext,
      nonce: nonce.toString('hex'),
      tag: tag.toString('hex'),
    };
  }
  /**
   * Decrypt data
   * @param {ciphertext: string, nonce: string, tag: string }
   * @returns {string} plaintext
   */
  decrypt(encrypted) {
    const nonce = Buffer.from(encrypted.nonce, 'hex');
    const decipher = crypto.createDecipheriv('chacha20-poly1305', this.key, nonce);
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

    let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }
  /**
   * Hash API key for secure storage using HMAC-SHA256.
   * Requires NODE_API_KEY_SECRET env var (min 32 bytes of entropy).
   * @param {string} apiKey
   * @returns {string} HMAC-SHA256 hex digest
   */
  hashAPIKey(apiKey) {
    const secret = process.env.NODE_API_KEY_SECRET;
    if (!secret) throw new Error('NODE_API_KEY_SECRET env var is required for API key hashing');
    return crypto.createHmac('sha256', secret).update(apiKey).digest('hex');
  }
}
