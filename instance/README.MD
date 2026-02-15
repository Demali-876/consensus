<p align="center">
<img src="assets/logo-light.svg" alt="Consensus logo" width="200" />
</p>

<h1 align="center">Consensus Network Node</h1>

<p align="center">
  Join the decentralized proxy network that powers <strong>deduplicated HTTP</strong>,<br>
  <strong>x402-secured payments</strong>, and <strong>deterministic external calls</strong> for modern blockchains.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@canister-software/consensus-node"><img alt="npm version" src="https://img.shields.io/npm/v/@canister-software/consensus-node.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue"></a>
  <a href="https://github.com/Demali-876/consensus/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demali-876/consensus?style=social"></a>
  <a href="#"><img alt="Status" src="https://img.shields.io/badge/status-beta-orange"></a>
</p>

<p align="center">
  • <a href="#quickstart">Quickstart</a>
  • <a href="#how-the-network-works">How It Works</a>
  • <a href="#node-architecture">Architecture</a>
  • <a href="#operator-requirements">Requirements</a>
  • <a href="#troubleshooting">Troubleshooting</a>
</p>

The **Consensus Network Node** is the worker component of the Consensus protocol — a decentralized proxy network designed to make external HTTP calls deterministic, secure, and economically aligned.

It enables:

- **Deduplication** of HTTP requests originating from blockchain replicas.
- **x402-secured payment verification** before execution.
- **Single execution** of external API calls with signature-backed results.
- **Deterministic caching**, ensuring identical responses for all replicas.
- **Fair rewards** for operators who process and serve responses across the network.

Nodes earn by completing paid tasks and serving cached responses, providing compute and bandwidth to the decentralized network.
Despite its capabilities, the node is lightweight enough to run on a **Raspberry Pi**, yet secure and performant enough for production environments.
