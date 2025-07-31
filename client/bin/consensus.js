#!/usr/bin/env node

import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
import { toAccount } from "viem/accounts";
import fs from "fs";
import crypto from "crypto";
import inquirer from "inquirer";
import figlet from "figlet";
import ora from "ora";
import chalk from "chalk";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function showBanner() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const pkg = await readFile(path.join(__dirname, "../package.json"), "utf8");
  const version = JSON.parse(pkg).version;

  const ascii = figlet.textSync("CONSENSUS\nClient", {
    font: "ANSI Shadow",
    horizontalLayout: "default",
    verticalLayout: "default",
  });

  console.log(chalk.black(ascii));
  console.log(chalk.dim(`v${version}\n`));

  console.log(
    chalk.gray(
      "• Stable IPs • HTTP Deduplication • Built for Blockchains \nPowered by x402 Payments\n"
    )
  );

  const spinner = ora("Launching Consensus Client...").start();

  await new Promise((resolve) => setTimeout(resolve, 800));
  spinner.succeed("Client CLI READY");
}

class ConsensusSDK {
  constructor() {
    this.configPath = path.join(process.cwd(), ".consensus-config.json");
    this.x402ProxyUrl = process.env.X402_PROXY_URL || "http://localhost:3001";
  }

  generateWalletName() {
    return crypto.randomBytes(8).toString("hex");
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      }
    } catch (error) {
      console.error(chalk.red("Error reading config:"), error.message);
    }
    return null;
  }

  saveConfig(config) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log(chalk.green("✓ Configuration saved"));

      const rootDir = path.resolve(__dirname, "../../");
      const gitignorePath = path.join(rootDir, ".gitignore");
      const ignoreEntry = path.basename(this.configPath);

      let gitignoreContents = "";
      if (fs.existsSync(gitignorePath)) {
        gitignoreContents = fs.readFileSync(gitignorePath, "utf8");
      }

      if (!gitignoreContents.split("\n").includes(ignoreEntry)) {
        fs.appendFileSync(
          gitignorePath,
          `\n# Ignore consensus config\n${ignoreEntry}\n`
        );
        console.log(chalk.yellow(`⚠️  .config hidden from git`));
      }
    } catch (error) {
      throw new Error(`Failed to save config: ${error.message}`);
    }
  }

  validateEnvironment() {
    const requiredVars = [
      "CDP_API_KEY_ID",
      "CDP_API_KEY_SECRET",
      "CDP_WALLET_SECRET",
    ];
    const missing = requiredVars.filter((varName) => !process.env[varName]);

    if (missing.length > 0) {
      console.error(chalk.red("Missing required environment variables:"));
      missing.forEach((varName) => console.error(chalk.red(`  ${varName}`)));
      console.log(chalk.yellow("\nCreate a .env file with:"));
      console.log("CDP_API_KEY_ID=your-api-key-id");
      console.log("CDP_API_KEY_SECRET=your-api-key-secret");
      console.log("CDP_WALLET_SECRET=your-wallet-secret");
      console.log("X402_PROXY_URL=http://localhost:3001  # (optional)");
      console.log(
        chalk.blue("\nGet CDP credentials: https://portal.cdp.coinbase.com/")
      );
      return false;
    }
    return true;
  }

  async checkExistingSetup(forceFlag) {
    const config = this.loadConfig();

    if (config) {
      console.log(chalk.yellow("⚠️  Existing Consensus setup found!"));
      console.log(chalk.cyan("Account Name:"), config.wallet_name);
      console.log(chalk.cyan("Account Address:"), config.account_address);
      console.log(chalk.cyan("Setup Date:"), config.setup_date);

      if (!forceFlag) {
        const { action } = await inquirer.prompt([
          {
            type: "list",
            name: "action",
            message: "What would you like to do?",
            choices: [
              { name: "Keep existing setup", value: "keep" },
              { name: "Create new setup (reset)", value: "reset" },
              { name: "Exit", value: "exit" },
            ],
          },
        ]);

        if (action === "keep") {
          console.log(chalk.green("Using existing setup"));
          return true;
        }
        if (action === "exit") {
          process.exit(0);
        }
        if (action === "reset") {
          return this.confirmReset();
        }
      } else {
        return this.confirmReset();
      }
    }

    return false;
  }

  async confirmReset() {
    console.log(
      chalk.red(
        "\n⚠️  WARNING: This will reset your account and create a new wallet."
      )
    );
    console.log(
      chalk.red("⚠️  Make sure to backup any funds from your current wallet!")
    );

    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: "Are you sure you want to continue?",
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log(chalk.yellow("Setup cancelled"));
      process.exit(0);
    }

    return false;
  }

  async createWallet() {
    const spinner = ora("Creating CDP wallet...").start();

    try {
      const cdp = new CdpClient();
      const walletName = this.generateWalletName();

      const cdpAccount = await cdp.evm.createAccount({ name: walletName });
      const account = toAccount(cdpAccount);

      spinner.succeed("CDP wallet created");

      return {
        wallet_name: walletName,
        account_address: account.address,
        cdpAccount: cdpAccount,
      };
    } catch (error) {
      spinner.fail("Failed to create CDP wallet");
      throw new Error(`Wallet creation failed: ${error.message}`);
    }
  }

  async registerWithProxy(walletName, accountAddress, cdpAccount) {
    const spinner = ora("Registering with x402 proxy...").start();

    try {
      const cdp = new CdpClient();
      const privateKeyData = await cdp.evm.exportAccount({ name: walletName });

      let privateKey;
      if (typeof privateKeyData === "string") {
        privateKey = privateKeyData.startsWith("0x")
          ? privateKeyData
          : `0x${privateKeyData}`;
      } else if (privateKeyData && privateKeyData.privateKey) {
        privateKey = privateKeyData.privateKey.startsWith("0x")
          ? privateKeyData.privateKey
          : `0x${privateKeyData.privateKey}`;
      } else {
        throw new Error("Unexpected private key format from CDP");
      }

      const response = await fetch(`${this.x402ProxyUrl}/register-wallet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          wallet_name: walletName,
          account_address: accountAddress,
          private_key: privateKey,
        }),
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: "Unknown error" }));
        throw new Error(
          error.error || `Registration failed: ${response.status}`
        );
      }

      const data = await response.json();
      spinner.succeed("Registered with x402 proxy");

      return data.api_key;
    } catch (error) {
      spinner.fail("Failed to register with x402 proxy");
      if (error.message.includes("ECONNREFUSED")) {
        throw new Error(
          "Cannot connect to x402 proxy. Is it running on " +
            this.x402ProxyUrl +
            "?"
        );
      }
      throw new Error(`Proxy registration failed: ${error.message}`);
    }
  }

  async setup() {
    try {
      console.log(chalk.blue.bold("Consensus SDK Setup\n"));

      if (!this.validateEnvironment()) {
        process.exit(1);
      }

      const forceFlag = process.argv.includes("--force");
      const shouldSkip = await this.checkExistingSetup(forceFlag);

      if (shouldSkip) {
        return;
      }

      const { wallet_name, account_address, cdpAccount } =
        await this.createWallet();
      const api_key = await this.registerWithProxy(
        wallet_name,
        account_address,
        cdpAccount
      );

      const config = {
        wallet_name,
        account_address,
        api_key,
        x402_proxy_url: this.x402ProxyUrl,
        setup_date: new Date().toISOString(),
        version: "1.0.0",
      };

      this.saveConfig(config);

      console.log(chalk.green.bold("\n✅ Setup Complete!\n"));
      console.log(chalk.cyan("Wallet Name:"), wallet_name);
      console.log(chalk.cyan("Account Address:"), account_address);
      console.log(chalk.cyan("API Key:"), api_key);
      console.log(chalk.cyan("x402 Proxy:"), this.x402ProxyUrl);

      console.log(chalk.yellow("\n📋 Next Steps:"));
      console.log("1. Fund your account with USDC on Base Sepolia");
      console.log(`   Address: ${account_address}`);
      console.log("2. Get USDC: https://faucet.circle.com/");
      console.log("3. Make API calls using your API key");

      console.log(chalk.blue("\n🔧 Usage Example:"));
      console.log(`curl -X POST ${this.x402ProxyUrl}/proxy \\`);
      console.log(`  -H "X-API-Key: ${api_key}" \\`);
      console.log('  -H "Content-Type: application/json" \\');
      console.log(
        `  -d '{"target_url": "https://api.example.com", "idempotency_key": "unique-key"}'`
      );
    } catch (error) {
      console.error(chalk.red("\n❌ Setup failed:"), error.message);
      process.exit(1);
    }
  }

  showHelp() {
    console.log(chalk.blue.bold("Consensus SDK\n"));
    console.log("Commands:");
    console.log("  setup          Create new account and register with proxy");
    console.log("  setup --force  Force create new account (reset existing)");
    console.log("  help           Show this help message");
    console.log("\nEnvironment variables required:");
    console.log("  CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET");
    console.log(
      "  X402_PROXY_URL (optional, defaults to http://localhost:3001)"
    );
    console.log(
      "\nAfter setup, use the API key from .consensus-config.json for requests"
    );
  }
}

async function main() {
  await showBanner();
  const sdk = new ConsensusSDK();
  const command = process.argv[2];

  switch (command) {
    case "setup":
      await sdk.setup();
      break;
    case "help":
    case "--help":
    case "-h":
      sdk.showHelp();
      break;
    default:
      if (!command) {
        sdk.showHelp();
      } else {
        console.error(chalk.red(`Unknown command: ${command}`));
        sdk.showHelp();
        process.exit(1);
      }
  }
}

main().catch((error) => {
  console.error(chalk.red("Error:"), error.message);
  process.exit(1);
});
