<p align="center">
  <picture>
    <source srcset="./assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="./assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="./assets/logo-light.svg" alt="Consensus logo" width="220" />
  </picture>
</p>

<h1 align="center">Consensus CLI</h1>

<p align="center">
  Command-line interface for the <strong>Consensus Network</strong>.<br>
  Setup, configure, and manage your <strong>x402-proxy delegations</strong> with ease.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@canister-software/consensus-cli"><img alt="npm version" src="https://img.shields.io/npm/v/@canister-software/consensus-cli.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue"></a>
  <a href="https://github.com/Demali-876/consensus/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demali-876/consensus?style=social"></a>
  <a href="#"><img alt="Status" src="https://img.shields.io/badge/status-beta-orange"></a>
</p>

<p align="center">
  • <a href="#installation">Installation</a>
  • <a href="#commands">Commands</a>
  • <a href="#setup-process">Setup Process</a>
  • <a href="#configuration">Configuration</a>
  • <a href="#keywords">Keywords</a>
</p>

## Setup Guide

Install the Consensus client library:

```bash
npm install consensus
```

The Consensus proxy uses Coinbase Developer Platform (CDP) to create and manage wallets. You'll need to provide CDP credentials in your project's root directory.

## Environment Variables

Create a `.env` file in the root of your project with the following required variables:

| Variable | Description |
|----------|-------------|
| <kbd>CDP_API_KEY_ID</kbd>   | Your CDP API key ID |
| <kbd>CDP_API_KEY_SECRET`</kbd> | Your CDP API key secret |
| <kbd>CDP_WALLET_SECRET</kbd> | Your CDP wallet secret |

Get your CDP credentials at: [https://portal.cdp.coinbase.com/](https://portal.cdp.coinbase.com/)

## Commands

These are the commands avaialable in the Consesnsus CLI:

|  Command                                                                     |  Description                                                   |
|---                                                                        |---                                                             |
| <kbd>setup</kbd>                                          | Create new account and register with `x402-proxy` |
| <kbd>setup --force</kbd>                                          | Force create new account (reset existing) |
| <kbd>help</kbd>                                          | Show help message |

## Setup Process

When you run the setup command, the Consensus client SDK will:

1. **Create a wallet** using your CDP credentials
2. **Generate a configuration file** (`.consensus-config.json`) containing your credentials
3. **Export wallet authorization** to the x402 proxy for payment delegation

> [!CAUTION]
> **DO NOT EXPOSE** the `.consensus-config.json` file as it contains sensitive information.
> The client automatically adds this file to `.gitignore` to prevent accidental commits.

> [!WARNING]
> **DO NOT keep large amounts** in the proxy-delegated wallet - if the proxy is compromised, your delegation could be at risk.
> Only fund the wallet with amounts you're comfortable delegating for API payments.
