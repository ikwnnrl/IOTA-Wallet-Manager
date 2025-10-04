# 🚀 IOTA Wallet Manager

Bot otomatis untuk multi-validator staking dan transfer IOTA dengan proxy support.

## ✨ Features
💰 Balance Check: Super minimal balance display for multiple wallets

🚰 Enhanced Faucet: Automated faucet claiming with real balance verification

🔄 Circular Transfers: Automated transfers in circular pattern (PK1→PK2→PK3→...→PK1)

🔒 Multi-Validator Staking: Automatic staking to all validators with random amounts

🔧 Proxy Support: Multi-format proxy support including http://user:pass@host:port

🎲 Smart Delays: Random delays (10-60s) to avoid rate limiting

⏰ 24H Auto Restart: Continuous operation with automatic restart cycles

## 🔧 Installation

### 1. Clone the Repository

git clone https://github.com/ikwnnrl/IOTA-Wallet-Manager.git

cd iota-wallet-manager

### 2. Install Dependencies

npm install chalk @iota/iota-sdk readline undici


### 3. Setup Files

pk.txt # Private keys (required)

proxy.txt # Proxy list (optional)

validators.txt # Validator addresses (optional)


### 4. Run

node index.js
