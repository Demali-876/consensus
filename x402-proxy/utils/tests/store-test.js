// utils/tests/database-test.js
import 'dotenv/config';
import { WalletStore } from '../../data/store.js';

async function testDatabaseConnection() {
  console.log('Testing database connection...\n');
  
  try {
    const walletStore = new WalletStore();
    
    console.log(`Using database path from env: ${process.env.CLIENT_DB_PATH}`);

    const info = walletStore.getDatabaseInfo();
    console.log('Database Info:');
    console.log(`   Path: ${info.path}`);
    console.log(`   Wallets: ${info.walletCount}`);
    console.log(`   Size: ${info.sizeBytes} bytes`);
    console.log(`   Exists: ${info.exists}`);

    walletStore.close();

    console.log('\n✅ Database test completed successfully!');

  } catch (error) {
    console.error('\n Database test failed:', error.message);
    process.exit(1);
  }
}

testDatabaseConnection();