import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ChaChaPoly1305 } from "../utils/encryption.js";
import "dotenv/config";

export class WalletStore {
  constructor(dbPath = process.env.CLIENT_DB_PATH) {
    if (!dbPath) {
      throw new Error("CLIENT_DB_PATH is missing");
    }
    this.dbPath = dbPath;
    this.db = null;
    this.cipher = new ChaChaPoly1305();
    this.initializeDatabase();
  }
  /**
   * Initialize database connection and create schema
   */
  initializeDatabase() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created database directory: ${dir}`);
      }

      this.db = new Database(this.dbPath);
      console.log(`Connected to database: ${this.dbPath}`);

      this.createSchema();
      this.testConnection();

      console.log("Database initialized successfully");
    } catch (error) {
      console.error("Failed to initialize database:", error.message);
      throw error;
    }
  }
  /**
   * Create database schema
   */
  createSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_name TEXT UNIQUE NOT NULL,
          account_address TEXT NOT NULL,
          encrypted_private_key TEXT NOT NULL,
          nonce TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          api_key_hash TEXT UNIQUE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_name ON wallets(wallet_name);
        CREATE INDEX IF NOT EXISTS idx_api_key_hash ON wallets(api_key_hash);
        CREATE INDEX IF NOT EXISTS idx_account_address ON wallets(account_address);
      `);

      console.log("Database schema created/verified");
    } catch (error) {
      console.error("Failed to create schema:", error.message);
      throw error;
    }
  }
  /**
   * Store wallet with encrypted private key
   */
  storeWallet(walletName, accountAddress, privateKey) {
    try {
      const apiKey = this.cipher.generateApiKey();
      const apiKeyHash = this.cipher.hashAPIKey(apiKey);
      const encrypted = this.cipher.encrypt(privateKey);
      const stmt = this.db.prepare(`
        INSERT INTO wallets (wallet_name, account_address, encrypted_private_key, nonce, auth_tag, api_key_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        walletName,
        accountAddress,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        apiKeyHash
      );
      return {
        success: true,
        apiKey: apiKey,
      };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`Wallet '${walletName}' already exists`);
      }
      throw error;
    }
  }
  /**
   * Get wallet by name and decrypt private key
   */
  getWallet(walletName) {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM wallets WHERE wallet_name = ?"
      );
      const row = stmt.get(walletName);
      if (!row) return null;

      const privateKey = this.cipher.decrypt({
        ciphertext: row.encrypted_private_key,
        nonce: row.nonce,
        tag: row.auth_tag,
      });
      return {
        walletName: row.wallet_name,
        accountAddress: row.account_address,
        privateKey: privateKey,
      };
    } catch (error) {
      console.error(`Failed to get wallet ${walletName}:`, error.message);
      return null;
    }
  }
  /**
   * Get wallet by API key and decrypt private key
   */
  getWalletByApiKey(apiKey) {
    try {
      const apiKeyHash = this.cipher.hashAPIKey(apiKey);

      const stmt = this.db.prepare(
        "SELECT * FROM wallets WHERE api_key_hash = ?"
      );
      const row = stmt.get(apiKeyHash);

      if (!row) return null;

      const privateKey = this.cipher.decrypt({
        ciphertext: row.encrypted_private_key,
        nonce: row.nonce,
        tag: row.auth_tag,
      });

      return {
        walletName: row.wallet_name,
        accountAddress: row.account_address,
        privateKey: privateKey,
      };
    } catch (error) {
      console.error("Failed to get wallet by API key:", error.message);
      return null;
    }
  }
  /**
   * Get all wallets with decrypted private keys (for server startup)
   */
  getAllWallets() {
    try {
      const stmt = this.db.prepare("SELECT * FROM wallets");
      const rows = stmt.all();

      return rows
        .map((row) => {
          try {
            const privateKey = this.cipher.decrypt({
              ciphertext: row.encrypted_private_key,
              nonce: row.nonce,
              tag: row.auth_tag,
            });

            return {
              walletName: row.wallet_name,
              accountAddress: row.account_address,
              privateKey: privateKey,
            };
          } catch (error) {
            console.error(`Failed to decrypt wallet ${row.wallet_name}`);
            return null;
          }
        })
        .filter((wallet) => wallet !== null);
    } catch (error) {
      console.error("Failed to get all wallets:", error.message);
      return [];
    }
  }
  /**
   * Check if wallet exists
   */
  walletExists(walletName) {
    try {
      const stmt = this.db.prepare(
        "SELECT 1 FROM wallets WHERE wallet_name = ?"
      );
      return stmt.get(walletName) !== undefined;
    } catch (error) {
      console.error("Failed to check wallet existence:", error.message);
      return false;
    }
  }
  /**
   * Test database connection
   */
  testConnection() {
    try {
      const result = this.db
        .prepare("SELECT COUNT(*) as count FROM wallets")
        .get();
      console.log(`Database test passed - ${result.count} wallets found`);
      return true;
    } catch (error) {
      console.error("Database connection test failed:", error.message);
      throw error;
    }
  }
  /**
   * Get database info
   */
  getDatabaseInfo() {
    try {
      const countResult = this.db
        .prepare("SELECT COUNT(*) as count FROM wallets")
        .get();
      const sizeResult = this.db
        .prepare(
          `
        SELECT page_count * page_size as size 
        FROM pragma_page_count(), pragma_page_size()
      `
        )
        .get();

      return {
        path: this.dbPath,
        walletCount: countResult.count,
        sizeBytes: sizeResult.size,
        exists: fs.existsSync(this.dbPath),
      };
    } catch (error) {
      console.error("Failed to get database info:", error.message);
      return null;
    }
  }
  /**
   * Close database connection
   */
  close() {
    try {
      if (this.db) {
        this.db.close();
        console.log("Database connection closed");
      }
    } catch (error) {
      console.error("Error closing database:", error.message);
    }
  }
}
