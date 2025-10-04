# 🚀 IOTA Wallet Manager

Bot otomatis untuk multi-validator staking dan transfer IOTA dengan proxy support.

## ✨ Features

- 🔄 **Auto Transfer**: 3 transfer random per wallet (0.001-0.01 IOTA)
- 🔒 **Multi-Staking**: Stake ke semua validator (1-3 IOTA per validator)  
- 🌐 **Proxy Support**: 1:1 mapping wallet dengan proxy
- ⏰ **Auto Loop**: Cycle otomatis dengan interval custom
- 📝 **Clean Logging**: Output yang rapi dan mudah dibaca

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
