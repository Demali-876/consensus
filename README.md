<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="Consensus logo" width="200" />
  </picture>
</p>

<h1 align="center">Consensus</h1>

<p align="center">
  HTTP deduplication protocol with secure, verifiable payments via <strong>x402</strong><br>
  HTTP as it should be for modern blockchains. Protect your APIs from the chaos of consensus
</p>

<p align="center">
  <a href="#"><img alt="Version" src="https://img.shields.io/badge/version-alpha-orange"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue"></a>
  <a href="https://github.com/Demali-876/consensus/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/Demali-876/consensus?style=social">
  </a>
  <a href="#"><img alt="Status" src="https://img.shields.io/badge/status-experimental-yellow"></a>
</p>

<p align="center">
  • <a href="#">Docs</a> 
  • <a href="#">Demo</a> 
  • <a href="https://sepolia.basescan.org/address/0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f#tokentxns">Testnet Transactions</a>
</p>

## Overview

Blockchain consensus algorithms are powerful — but they come with baggage.

On the Internet Computer (ICP), for example, when an application subnet performs an HTTP outcall, **each node** in the subnet independently makes the request. These nodes run replicas, and the responses from the HTTP outcalls are compared in the consensus process. This means:

* The same HTTP request is made by every node in the subnet (typically 13 for ICP).
* Millisecond differences can lead to inconsistent responses.
* The **transform function** can sanitize these differences, but it doesn’t reduce the number of requests.
* Each request originates from a **different physical machine**, meaning **no shared IP address** — breaking determinism for services that rely on caller identity.

This especially becomes a problem when your target endpoint is **not idempotent**.

Even if only one response is used, your service may still receive **multiple requests**, potentially triggering **duplicate processing**, **double charges**, or **conflicting writes**.

> With Consensus Proxy, only **1 request is executed** — no matter how many are sent.
> In consensus-based systems like ICP, this reduces outbound traffic by up to **\~93%**.
> It also eliminates **duplicate hits** that waste resources, exceed rate limits, or create billing issues.

Whether your backend is a serverless function, a rate-limited SaaS API, or a payment gateway, Consensus Proxy ensures you **pay once, process once — regardless of how many nodes, retries, or consensus rounds are involved**.

---

## Consensus Proxy

Consensus Proxy solves this problem at the protocol level.

It acts as a **deduplication layer** that:

* Receives all node-originated HTTP outcalls
* Executes the request **exactly once**
* Caches and returns the same result to all callers
* Challenges the caller with **x402** to ensure payment before processing

---

## How it works

Without deduplication, every replica sends its own request — resulting in N redundant API hits per consensus round.

With Consensus Proxy, the **first request triggers an [x402](https://www.x402.org) payment challenge**. The client retries using a wrapper (like `fetch-with-payment`), and upon successful verification, the proxy settles the request, makes the external call, and caches the result for reuse.

```mermaid
sequenceDiagram
    participant R1 as Node 1
    participant R2 as Node 2
    participant R3 as Node 3
    participant P as Proxy (x402-protected)
    participant API as External API
    participant C as Consensus

    R1->>P: HTTP outcall (idempotency: icp23072025, x-api-key: ba137)
    R2->>P: HTTP outcall (idempotency: icp23072025, x-api-key: ba137)
    R3->>P: HTTP outcall (idempotency: icp23072025, x-api-key: ba137)

    Note right of P: First request → cache MISS → x402 challenge

    P-->>R1: 402 Payment Required (x402 challenge)
    R1->>P: Retry using fetch-with-payment

    Note right of P: Payment verified → request settled

    P->>API: External API call
    API-->>P: Response: {"usd": 6.09}

    Note right of P: Response cached → reused for remaining requests

    P-->>R1: Cached response
    P-->>R2: Cached response
    P-->>R3: Cached response

    R1->>C: Process response → State A
    R2->>C: Process response → State A
    R3->>C: Process response → State A

    C-->>R1: Consensus reached
    C-->>R2: Consensus reached
    C-->>R3: Consensus reached

    Note right of C: All replicas receive the same response
```

---

### Step-by-Step

1. **All nodes in a subnet execute the same canister function**, triggering identical HTTP outcalls.
2. Each node sends its request to the **Consensus Proxy**, including an idempotency key.
3. The **first request** is met with an **x402 challenge** — a payment requirement.
4. The client request is wrapped automatically to fetch the data with payment, **settling the request**.
5. The proxy **makes the external API call** and **caches the result**.
6. All remaining requests with the same idempotency key receive the **cached response**.
7. Replicas process identical responses → **state converges** → **consensus succeeds**.
