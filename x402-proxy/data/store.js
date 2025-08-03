import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

export class WalletStore {
    constructor(dbPath = process.env.CLIENT_DB_PATH) {
    if (!dbPath) {
      throw new Error('CLIENT_DB_PATH is missing');
    }
    this.dbPath = dbPath;
    this.db = null;
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

      console.log('Database initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize database:', error.message);
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
          api_key TEXT UNIQUE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_name ON wallets(wallet_name);
        CREATE INDEX IF NOT EXISTS idx_api_key ON wallets(api_key);
        CREATE INDEX IF NOT EXISTS idx_account_address ON wallets(account_address);
      `);
      
      console.log('Database schema created/verified');
    } catch (error) {
      console.error('Failed to create schema:', error.message);
      throw error;
    }
  }
  /**
   * Test database connection
   */
  testConnection() {
    try {
      const result = this.db.prepare('SELECT COUNT(*) as count FROM wallets').get();
      console.log(`Database test passed - ${result.count} wallets found`);
      return true;
      
    } catch (error) {
      console.error('Database connection test failed:', error.message);
      throw error;
    }
  }
  /**
   * Get database info
   */
  getDatabaseInfo() {
    try {
      const countResult = this.db.prepare('SELECT COUNT(*) as count FROM wallets').get();
      const sizeResult = this.db.prepare(`
        SELECT page_count * page_size as size 
        FROM pragma_page_count(), pragma_page_size()
      `).get();
      
      return {
        path: this.dbPath,
        walletCount: countResult.count,
        sizeBytes: sizeResult.size,
        exists: fs.existsSync(this.dbPath)
      };
      
    } catch (error) {
      console.error('Failed to get database info:', error.message);
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
        console.log('Database connection closed');
      }
    } catch (error) {
      console.error('Error closing database:', error.message);
    }
  }
}