/**
 * IOTA Wallet Manager v2.5 - COMPLETE VERSION WITH REAL FAUCET VERIFICATION
 * =========================================================================
 * ✅ Menu 1: Super minimal balance check (local IP only)
 * ✅ Menu 5: Circular transfer flow (PK1→PK2→PK3→...→PK26→PK1)
 * ✅ FAUCET: Real balance verification (before/after check)
 * ✅ Random delay retry (10s-1m) 
 * ✅ Fixed proxy URL format support
 * ✅ 24H auto restart
 */

const chalk = require("chalk");
const { IotaClient, getFullnodeUrl } = require("@iota/iota-sdk/client");
const { Ed25519Keypair } = require("@iota/iota-sdk/keypairs/ed25519");
const { Transaction } = require("@iota/iota-sdk/transactions");
const { decodeIotaPrivateKey } = require("@iota/iota-sdk/cryptography");
const { getFaucetHost, requestIotaFromFaucetV1 } = require("@iota/iota-sdk/faucet");
const { NANOS_PER_IOTA } = require("@iota/iota-sdk/utils");
const fs = require("fs");
const readline = require("readline");
const { ProxyAgent } = require("undici");
const https = require("https");

// ===================================================================================
// CONFIGURATION WITH CIRCULAR & RANDOM DELAY FIXES
// ===================================================================================
const PK_FILE = 'pk.txt';
const VALIDATORS_FILE = 'validators.txt';
const CONFIG_FILE = 'config.json';
const USER_AGENTS_FILE = 'user_agents.txt';
const PROXY_FILE = 'proxy.txt';

// Circular Processing Configuration (Menu 5)
const TRANSFERS_PER_WALLET_SEQUENTIAL = 2; // 2 transfers per wallet in circular pattern
const TOTAL_TRANSFERS_EXPECTED = 52; // Target total transfers

// Original configuration for other menus
const TRANSFERS_PER_WALLET = 3;
const MIN_STAKE_AMOUNT = 1;
const MAX_STAKE_AMOUNT = 3;
const MIN_DELAY_MS = 10000;
const MAX_DELAY_MS = 30000;
const GAS_FEE_BUFFER_NANOS = BigInt(50_000_000);
const FAUCET_RETRIES = 10;
const TRANSACTION_RETRIES = 10;
const RETRY_DELAY_MS = 3000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
const HOURS_1_MS = 60 * 60 * 1000;
const MIN_TRANSFER_AMOUNT = 0.001;
const MAX_TRANSFER_AMOUNT = 0.01;

// Enhanced Faucet Configuration with Real Verification
const RATE_LIMIT_RETRY_ATTEMPTS = 10;
const RATE_LIMIT_RETRY_DELAY_MIN = 10000; // 10 seconds (FIXED)
const RATE_LIMIT_RETRY_DELAY_MAX = 60000;  // 1 minute (FIXED)
const FAUCET_24H_AUTO_RESTART = true;
const FAUCET_RESTART_INTERVAL_HOURS = 24;
const BALANCE_CHECK_DELAY = 5000; // Wait 5s after faucet request for balance verification

const DEFAULT_TESTNET_VALIDATORS = [
    "0x1c6b89f4d5ee1af5d0b9c0f67f7c8e4a2b1a3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "0x2d7c9a5f6e7a1b6f5d0c9b8f6e7a1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    "0x3e8d0b6f7e8a2c7f6e1d0c9b8f6e7a2d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a1c"
];

const FAUCET_LIMIT_PATTERNS = [
    'rate limit', 'too many requests', 'limit exceeded', 'already claimed',
    'wait before', 'cooldown', 'try again later', 'quota exceeded',
    'maximum requests', 'throttled', '429', 'already received',
    'claim limit', 'daily limit', 'per day', '24 hours', 'forbidden',
    'blocked', 'banned', 'restricted'
];

// ===================================================================================
// GLOBAL VARIABLES
// ===================================================================================
let iotaClient;
let selectedNetwork;
let autoLoopInterval = null;
let isAutoLoopRunning = false;

// Enhanced Faucet Variables
let isRunningContinuousFaucet = false;
let faucetRestartInterval = null;
let nextFaucetRestartTime = null;
let faucetCountdownInterval = null;
let globalFaucetStats = {};

// Enhanced Auto Loop Variables
let isRunningFullCycle = false;
let nextRunTime = null;
let countdownInterval = null;
let globalCycleStats = {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===================================================================================
// SIMPLE LOGGING FUNCTIONS
// ===================================================================================
function logBlankLine() {
    console.log('');
}

function logSeparator(type = 'normal') {
    const separators = {
        thick: "━".repeat(80),
        normal: "─".repeat(80),
        double: "═".repeat(80),
        dotted: "┅".repeat(80),
    };
    console.log(chalk.cyan(separators[type] || separators.normal));
}

function logHeader(title, subtitle = null) {
    logBlankLine();
    logSeparator('thick');
    console.log(chalk.bold.blue(` 🚀 ${title.toUpperCase()} `));
    if (subtitle) {
        console.log(chalk.gray(` ${subtitle} `));
    }
    logSeparator('thick');
    logBlankLine();
}

function logError(message, details = null) {
    console.log(chalk.red(`❌ ${message}`));
    if (details) {
        console.log(chalk.red(`   ${details.slice(0, 60)}...`));
    }
}

function logSuccess(message, details = null) {
    console.log(chalk.green(`✅ ${message}`));
    if (details) {
        console.log(chalk.gray(`   ${details}`));
    }
}

function logWarning(message, details = null) {
    console.log(chalk.yellow(`⚠️ ${message}`));
    if (details) {
        console.log(chalk.yellow(`   ${details}`));
    }
}

function logInfo(message, details = null) {
    console.log(chalk.blue(`ℹ️ ${message}`));
    if (details) {
        console.log(chalk.gray(`   ${details}`));
    }
}

// ===================================================================================
// UTILITY FUNCTIONS
// ===================================================================================
function generateRandomDelay() {
    return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function getCurrentTimestamp() {
    return new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatCountdownTime(milliseconds) {
    if (milliseconds <= 0) return '00:00:00';
    
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function calculateNextRunTime(intervalHours) {
    const now = new Date();
    return new Date(now.getTime() + (intervalHours * 60 * 60 * 1000));
}

function generateRandomAmount(min = MIN_TRANSFER_AMOUNT, max = MAX_TRANSFER_AMOUNT) {
    const randomAmount = Math.random() * (max - min) + min;
    return parseFloat(randomAmount.toFixed(6));
}

function generateRandomStakeAmount() {
    const randomAmount = Math.random() * (MAX_STAKE_AMOUNT - MIN_STAKE_AMOUNT) + MIN_STAKE_AMOUNT;
    return parseFloat(randomAmount.toFixed(6));
}

// ===================================================================================
// FILE OPERATIONS
// ===================================================================================
function loadConfig() {
    try {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(configData);
    } catch (error) {
        return {
            autoLoop: {
                enabled: false,
                intervalHours: 24,
                enableStaking: true,
                enableFaucet: true,
                lastRun: null
            }
        };
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        logError('Failed to save config', error.message);
        return false;
    }
}

function readLinesFromFile(filename) {
    try {
        return fs.readFileSync(filename, 'utf-8').split('\n').map(line => line.trim()).filter(line => line !== '');
    } catch (error) {
        if (filename !== PROXY_FILE && filename !== VALIDATORS_FILE) {
            logError(`Failed to read file '${filename}'`, error.message);
        }
        return [];
    }
}

function createKeypairFromPrivateKey(privateKeyString) {
    try {
        if (privateKeyString.startsWith('iotaprivkey1')) {
            const { secretKey } = decodeIotaPrivateKey(privateKeyString);
            return Ed25519Keypair.fromSecretKey(secretKey);
        } else if (/^[0-9a-fA-F]{64}$/.test(privateKeyString)) {
            const secretKeyBytes = Buffer.from(privateKeyString, 'hex');
            return Ed25519Keypair.fromSecretKey(secretKeyBytes);
        } else if (/^[0-9a-fA-F]{66}$/.test(privateKeyString) && privateKeyString.startsWith('0x')) {
            const secretKeyBytes = Buffer.from(privateKeyString.slice(2), 'hex');
            return Ed25519Keypair.fromSecretKey(secretKeyBytes);
        } else {
            throw new Error('Unknown private key format');
        }
    } catch (error) {
        throw new Error(`Invalid private key format: ${error.message}`);
    }
}

// ===================================================================================
// SUPER MINIMAL BALANCE CHECK (MENU 1)
// ===================================================================================
async function checkBalancesMinimal(callback) {
    logBlankLine();
    console.log(chalk.bold.blue('💰 Balance Check'));
    logBlankLine();

    // Load wallets directly without proxy complexity
    const wallets = loadWalletsMinimal();
    if (wallets.length === 0) {
        console.log(chalk.red('No wallets found'));
        setTimeout(callback, 1500);
        return;
    }

    let total = 0;
    let successCount = 0;

    // Check each wallet directly
    for (const wallet of wallets) {
        try {
            const balance = await iotaClient.getBalance({ owner: wallet.address });
            const iotaBalance = parseInt(balance.totalBalance) / Number(NANOS_PER_IOTA);
            total += iotaBalance;
            successCount++;

            // Simple color coding
            const color = iotaBalance > 0.01 ? chalk.green : iotaBalance > 0.001 ? chalk.yellow : chalk.red;
            console.log(`PK${wallet.pk}: ${color(iotaBalance.toFixed(6))} IOTA`);

        } catch (error) {
            console.log(`PK${wallet.pk}: ${chalk.red('ERROR')}`);
        }
        await sleep(100); // Faster check
    }

    logBlankLine();
    console.log(`Total: ${chalk.blue(total.toFixed(6))} IOTA (${successCount} wallets)`);
    logBlankLine();
    
    rl.question(chalk.yellow('Press Enter...'), () => callback());
}

// ===================================================================================
// MINIMAL WALLET LOADING FOR BALANCE CHECK - NO PROXY, DIRECT LOCAL IP
// ===================================================================================
function loadWalletsMinimal() {
    try {
        const privateKeyLines = fs.readFileSync(PK_FILE, 'utf-8').split('\n');
        const wallets = [];
        let pkNumber = 1;

        for (const line of privateKeyLines) {
            const trimmed = line.trim();
            
            // Skip empty lines and comments
            if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }

            try {
                // Create keypair directly
                const keypair = createKeypairFromPrivateKey(trimmed);
                const address = keypair.getPublicKey().toIotaAddress();
                
                wallets.push({
                    pk: pkNumber,
                    keypair,
                    address
                });

                pkNumber++;
            } catch (error) {
                // Skip invalid private keys silently
                pkNumber++;
                continue;
            }
        }

        return wallets;
        
    } catch (error) {
        console.log(chalk.red(`Error loading wallets: ${error.message}`));
        return [];
    }
}

// ===================================================================================
// ENHANCED PROXY VALIDATION WITH URL FORMAT FIX (FOR OTHER MENUS)
// ===================================================================================
function validateAndFormatProxy(proxyString, lineNumber) {
    if (!proxyString || proxyString.trim() === '') {
        return {
            isValid: true,
            proxy: null,
            display: 'LOCAL_IP',
            error: null,
            hasAuth: false,
            format: 'none'
        };
    }

    const trimmed = proxyString.trim();
    
    if (trimmed.startsWith('#')) {
        return {
            isValid: true,
            proxy: null,
            display: 'LOCAL_IP',
            error: null,
            hasAuth: false,
            format: 'comment'
        };
    }

    try {
        let host, port, username, password, detectedFormat;

        // Format 1: http://username:password@host:port | https://username:password@host:port
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            try {
                const url = new URL(trimmed);
                host = url.hostname;
                port = url.port;
                username = url.username;
                password = url.password;
                detectedFormat = 'url_full';
                
                // Set default port if not specified
                if (!port) {
                    port = url.protocol === 'https:' ? '443' : '8080';
                }
                
                // Validate that we have all required parts
                if (!host) {
                    throw new Error('Missing hostname in URL');
                }
                
            } catch (urlError) {
                throw new Error(`Invalid URL format: ${urlError.message}`);
            }
        }
        // Format 2: username:password@host:port
        else if (trimmed.includes('@') && !trimmed.startsWith('http')) {
            const [authPart, hostPart] = trimmed.split('@');
            if (authPart && hostPart) {
                const authSplit = authPart.split(':');
                const hostSplit = hostPart.split(':');
                
                if (authSplit.length === 2 && hostSplit.length === 2) {
                    [username, password] = authSplit;
                    [host, port] = hostSplit;
                    detectedFormat = 'auth_at_host';
                } else {
                    throw new Error('Invalid auth@host format');
                }
            } else {
                throw new Error('Missing auth or host part in @ format');
            }
        }
        // Format 3: host:port:username:password (original format)
        else {
            const parts = trimmed.split(':');
            if (parts.length === 2) {
                [host, port] = parts;
                detectedFormat = 'host_port';
            } else if (parts.length === 4) {
                [host, port, username, password] = parts;
                detectedFormat = 'host_port_user_pass';
            } else {
                throw new Error(`Invalid colon format. Expected host:port or host:port:user:pass, got ${parts.length} parts`);
            }
        }

        if (!host || host.trim() === '') {
            throw new Error('Empty or invalid host');
        }

        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
            throw new Error(`Invalid port ${port}. Must be 1-65535`);
        }

        if (username && !password) {
            throw new Error('Username provided but password is missing');
        }
        if (password && !username) {
            throw new Error('Password provided but username is missing');
        }

        const display = `${host}:${port}`;
        const hasAuth = !!(username && password);
        
        // FIXED: Create proper proxy format - preserve original URL format
        let proxyForRequest;
        if (detectedFormat === 'url_full') {
            // Keep original URL format for URL-based proxies
            proxyForRequest = trimmed;
        } else if (hasAuth) {
            proxyForRequest = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
        } else {
            proxyForRequest = `http://${host}:${port}`;
        }

        return {
            isValid: true,
            proxy: proxyForRequest,
            display: display,
            error: null,
            hasAuth: hasAuth,
            format: detectedFormat,
            originalFormat: trimmed,
            host: host,
            port: port,
            username: username || null,
            password: password || null
        };

    } catch (error) {
        return {
            isValid: false,
            proxy: null,
            display: 'INVALID_FORMAT',
            error: `Line ${lineNumber}: ${error.message}`,
            hasAuth: false,
            format: 'invalid'
        };
    }
}

// ===================================================================================
// IMPROVED WALLET LOADING WITH PROPER PROXY MAPPING (FOR OTHER MENUS)
// ===================================================================================
function loadWalletsWithProxyMapping() {
    const privateKeyLines = fs.readFileSync(PK_FILE, 'utf-8').split('\n') || [];
    const proxyLines = fs.readFileSync(PROXY_FILE, 'utf-8').split('\n') || [];
    
    console.log(chalk.blue(`📄 Loading from ${PK_FILE}: ${privateKeyLines.length} lines`));
    console.log(chalk.blue(`📄 Loading from ${PROXY_FILE}: ${proxyLines.length} lines`));
    console.log(chalk.blue(`🔧 Multi-format proxy support: URL | Auth@Host | Host:Port:User:Pass | Host:Port`));
    
    const walletProxyPairs = [];
    const errors = [];

    for (let lineIndex = 0; lineIndex < privateKeyLines.length; lineIndex++) {
        const pkLine = privateKeyLines[lineIndex] || '';
        const proxyLine = proxyLines[lineIndex] || '';
        
        const trimmedPK = pkLine.trim();
        
        if (trimmedPK === '' || trimmedPK.startsWith('#')) {
            continue;
        }

        try {
            const keypair = createKeypairFromPrivateKey(trimmedPK);
            const address = keypair.getPublicKey().toIotaAddress();

            const proxyValidation = validateAndFormatProxy(proxyLine, lineIndex + 1);
            
            if (!proxyValidation.isValid) {
                errors.push(proxyValidation.error);
                proxyValidation.proxy = null;
                proxyValidation.display = 'LOCAL_IP';
            }

            walletProxyPairs.push({
                index: walletProxyPairs.length,
                originalLineNumber: lineIndex + 1,
                keypair,
                address,
                privateKey: trimmedPK,
                proxy: proxyValidation.proxy,
                proxyDisplay: proxyValidation.display,
                hasProxyAuth: proxyValidation.hasAuth || false,
                proxyFormat: proxyValidation.format || 'none',
                proxyOriginal: proxyValidation.originalFormat || null,
                proxyHost: proxyValidation.host || null,
                proxyPort: proxyValidation.port || null,
                proxyUsername: proxyValidation.username || null,
                proxyPassword: proxyValidation.password || null
            });

            const proxyInfo = proxyValidation.proxy ?
                chalk.cyan(proxyValidation.display) :
                chalk.yellow('LOCAL_IP');
            logSuccess(`PK${lineIndex + 1} → ${proxyInfo}`);
            
        } catch (error) {
            const errorMsg = `Line ${lineIndex + 1}: Invalid private key - ${error.message}`;
            errors.push(errorMsg);
            logError(`Skip PK${lineIndex + 1}`, error.message);
        }
    }

    if (errors.length > 0) {
        console.log(chalk.yellow(`⚠️ Found ${errors.length} errors during loading`));
    }

    console.log(chalk.green(`✅ Loaded ${walletProxyPairs.length} valid wallet-proxy pairs with 1:1 multi-format mapping`));
    
    return walletProxyPairs;
}

function getValidators() {
    let validators = readLinesFromFile(VALIDATORS_FILE).filter(line => line.trim() !== '' && !line.startsWith('#'));

    if (validators.length === 0) {
        if (selectedNetwork === 'testnet' || selectedNetwork === 'devnet') {
            validators = DEFAULT_TESTNET_VALIDATORS;
            logWarning('Using default testnet validators');
        }
    } else {
        logSuccess(`Loaded ${validators.length} validators from file`);
    }

    return validators;
}

// ===================================================================================
// TRANSACTION FUNCTIONS
// ===================================================================================
async function executeTransactionWithRetries(keypair, tx) {
    for (let attempt = 1; attempt <= TRANSACTION_RETRIES; attempt++) {
        try {
            const result = await iotaClient.signAndExecuteTransaction({
                signer: keypair,
                transaction: tx
            });
            return { success: true, result, attempt };
        } catch (error) {
            logError(`Attempt ${attempt}/${TRANSACTION_RETRIES}`, error.message.slice(0, 80));
            if (attempt < TRANSACTION_RETRIES) {
                logInfo(`Retrying in ${RETRY_DELAY_MS / 1000} seconds`);
                await sleep(RETRY_DELAY_MS);
            } else {
                return { success: false, error };
            }
        }
    }
}

// ===================================================================================
// REAL FAUCET VERIFICATION WITH BALANCE CHECK
// ===================================================================================
async function requestFaucetWithProxy(address, proxyString, userAgent, walletInfo = null) {
    try {
        let faucetUrl;
        if (selectedNetwork === 'testnet') {
            faucetUrl = 'https://faucet.testnet.iota.cafe/v1/gas';
        } else if (selectedNetwork === 'devnet') {
            faucetUrl = 'https://faucet.devnet.iota.cafe/v1/gas';
        } else {
            throw new Error('Faucet only available on testnet and devnet');
        }

        // Check balance BEFORE faucet request
        console.log(chalk.gray(`      💰 Checking balance before faucet...`));
        let balanceBefore = 0;
        try {
            const balanceResponseBefore = await iotaClient.getBalance({ owner: address });
            balanceBefore = parseInt(balanceResponseBefore.totalBalance) / Number(NANOS_PER_IOTA);
            console.log(chalk.gray(`      Balance before: ${balanceBefore.toFixed(6)} IOTA`));
        } catch (balanceError) {
            console.log(chalk.yellow(`      ⚠️ Could not check balance before: ${balanceError.message}`));
        }

        const requestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'DNT': '1',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'cross-site',
                'Connection': 'keep-alive'
            },
            body: JSON.stringify({
                FixedAmountRequest: {
                    recipient: address
                }
            }),
            timeout: 45000
        };

        // Enhanced proxy setup with better validation
        if (proxyString && proxyString.trim() !== '') {
            try {
                console.log(chalk.gray(`      🔧 Setting up proxy: ${proxyString.slice(0, 30)}...`));
                
                if (proxyString.startsWith('http://') || proxyString.startsWith('https://')) {
                    try {
                        new URL(proxyString);
                        requestOptions.dispatcher = new ProxyAgent(proxyString);
                        console.log(chalk.gray(`      ✅ Proxy setup successful`));
                    } catch (urlError) {
                        console.log(chalk.yellow(`      ⚠️ Invalid proxy URL: ${urlError.message}`));
                        console.log(chalk.yellow(`      ⚠️ Falling back to direct connection`));
                    }
                } else {
                    console.log(chalk.yellow(`      ⚠️ Non-URL proxy format, using direct connection`));
                }
                
            } catch (proxyError) {
                console.log(chalk.yellow(`      ⚠️ Proxy setup failed: ${proxyError.message.slice(0, 40)}...`));
                console.log(chalk.yellow(`      ⚠️ Falling back to direct connection`));
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        try {
            console.log(chalk.gray(`      📤 Sending faucet request...`));
            const response = await fetch(faucetUrl, {
                ...requestOptions,
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            const responseText = await response.text();
            
            console.log(chalk.gray(`      📥 Response status: ${response.status}`));
            console.log(chalk.gray(`      📄 Response preview: ${responseText.slice(0, 100)}...`));
            
            if (response.ok) {
                let responseData = null;
                try {
                    responseData = JSON.parse(responseText);
                    console.log(chalk.gray(`      📊 Parsed response keys: ${Object.keys(responseData).join(', ')}`));
                } catch (parseError) {
                    console.log(chalk.yellow(`      ⚠️ Could not parse JSON response`));
                }

                // Wait a bit for transaction to be processed
                console.log(chalk.gray(`      ⏱️ Waiting ${BALANCE_CHECK_DELAY / 1000}s for transaction processing...`));
                await sleep(BALANCE_CHECK_DELAY);

                // Check balance AFTER faucet request to verify
                console.log(chalk.gray(`      💰 Checking balance after faucet...`));
                let balanceAfter = 0;
                try {
                    const balanceResponseAfter = await iotaClient.getBalance({ owner: address });
                    balanceAfter = parseInt(balanceResponseAfter.totalBalance) / Number(NANOS_PER_IOTA);
                    console.log(chalk.gray(`      Balance after: ${balanceAfter.toFixed(6)} IOTA`));
                } catch (balanceError) {
                    console.log(chalk.yellow(`      ⚠️ Could not check balance after: ${balanceError.message}`));
                }

                const actualReceived = balanceAfter - balanceBefore;
                console.log(chalk.gray(`      💎 Actual received: ${actualReceived.toFixed(6)} IOTA`));

                if (actualReceived > 0) {
                    // Real success - balance actually increased
                    return {
                        success: true,
                        digest: responseData?.digest || responseData?.transactionDigest || responseData?.txDigest || null,
                        amount: actualReceived,
                        verified: true,
                        balanceBefore: balanceBefore,
                        balanceAfter: balanceAfter
                    };
                } else {
                    // Fake success - no balance increase
                    return {
                        success: false,
                        isLimitReached: true, // Likely rate limited or already claimed
                        error: `No balance increase detected. Before: ${balanceBefore.toFixed(6)}, After: ${balanceAfter.toFixed(6)}`,
                        actualReceived: actualReceived,
                        verified: true,
                        balanceBefore: balanceBefore,
                        balanceAfter: balanceAfter
                    };
                }
                
            } else {
                const responseBodyLower = responseText.toLowerCase();
                const statusCode = response.status;
                
                const isRateLimited = 
                    statusCode === 429 ||
                    statusCode === 403 ||
                    statusCode === 503 ||
                    statusCode === 502 ||
                    FAUCET_LIMIT_PATTERNS.some(pattern => responseBodyLower.includes(pattern));

                return {
                    success: false,
                    isLimitReached: isRateLimited,
                    error: `HTTP ${statusCode}: ${responseText.slice(0, 100)}`,
                    statusCode: statusCode,
                    responseBody: responseText.slice(0, 200),
                    verified: false
                };
            }
        } finally {
            clearTimeout(timeoutId);
        }

    } catch (error) {
        const errorMessageLower = error.message.toLowerCase();
        
        const isRateLimited = 
            FAUCET_LIMIT_PATTERNS.some(pattern => errorMessageLower.includes(pattern)) ||
            errorMessageLower.includes('rate') ||
            errorMessageLower.includes('limit') ||
            errorMessageLower.includes('429') ||
            errorMessageLower.includes('403');

        return {
            success: false,
            isLimitReached: isRateLimited,
            error: error.message,
            errorType: error.name === 'AbortError' ? 'timeout' : 'network_error',
            verified: false
        };
    }
}

function isLimitError(errorMessage) {
    const lowerError = errorMessage.toLowerCase();
    return FAUCET_LIMIT_PATTERNS.some(pattern => lowerError.includes(pattern));
}

// ===================================================================================
// ENHANCED FAUCET WITH REAL VERIFICATION
// ===================================================================================
async function requestFaucetWithRateLimitRetry(address, userAgent, proxyString, maxAttempts = 50) {
    let successCount = 0;
    let failedCount = 0;
    let rateLimitRetries = 0;
    let totalEarned = 0;
    let totalFakeSuccess = 0;
    const startTime = Date.now();

    console.log(chalk.blue(`   🚰 Starting VERIFIED claiming (max ${maxAttempts} attempts)`));
    console.log(chalk.gray(`   🔍 With real balance verification`));
    console.log(chalk.gray(`   🎲 Rate limit retry: Random delay 10s-60s`));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(chalk.blue(`   📤 Attempt #${attempt}/${maxAttempts}`));
        const result = await requestFaucetWithProxy(address, proxyString, userAgent);
        
        if (result.success && result.verified) {
            successCount++;
            const actualAmount = result.amount;
            totalEarned += actualAmount;
            console.log(chalk.green(`   ✅ VERIFIED SUCCESS: +${actualAmount.toFixed(6)} IOTA (Real balance increase!)`));
            console.log(chalk.gray(`      Before: ${result.balanceBefore.toFixed(6)} → After: ${result.balanceAfter.toFixed(6)}`));
            await sleep(2000);
        } else if (result.success && !result.verified) {
            // This shouldn't happen with new code, but just in case
            totalFakeSuccess++;
            console.log(chalk.yellow(`   ⚠️ FAKE SUCCESS: Response OK but no balance increase`));
            await sleep(2000);
        } else if (result.isLimitReached) {
            if (rateLimitRetries < RATE_LIMIT_RETRY_ATTEMPTS) {
                rateLimitRetries++;
                
                const randomDelay = Math.floor(Math.random() * (RATE_LIMIT_RETRY_DELAY_MAX - RATE_LIMIT_RETRY_DELAY_MIN + 1)) + RATE_LIMIT_RETRY_DELAY_MIN;
                const minutes = Math.floor(randomDelay / 60000);
                const seconds = Math.floor((randomDelay % 60000) / 1000);
                
                console.log(chalk.yellow(`   ⚠️ Rate limit/No balance increase - Retry ${rateLimitRetries}/${RATE_LIMIT_RETRY_ATTEMPTS} in ${minutes}m${seconds}s`));
                console.log(chalk.gray(`   🎲 Random delay: ${Math.round(randomDelay / 1000)}s (10-60s range)`));
                console.log(chalk.gray(`   📄 Error: ${result.error.slice(0, 80)}`));
                await sleep(randomDelay);
                attempt--; // Don't count this as an attempt
                continue;
            } else {
                console.log(chalk.red(`   ❌ Rate limit retries exhausted after ${rateLimitRetries} attempts`));
                break;
            }
        } else {
            failedCount++;
            console.log(chalk.red(`   ❌ Claim #${attempt} FAILED: ${result.error.slice(0, 50)}`));
            if (failedCount >= 3) {
                console.log(chalk.red(`   ❌ Too many consecutive failures, stopping`));
                break;
            }
            await sleep(3000);
        }
    }

    const elapsedMinutes = Math.round((Date.now() - startTime) / 60000);
    return {
        successCount,
        failedCount,
        totalEarned,
        rateLimitRetries,
        elapsedMinutes,
        fakeSuccessCount: totalFakeSuccess
    };
}

async function runEnhancedAutoFaucet(callback) {
    if (selectedNetwork === 'mainnet') {
        logError("Faucet not available on Mainnet");
        callback();
        return;
    }

    logHeader("ENHANCED AUTO FAUCET WITH VERIFICATION", "Real Balance Verification | Rate Limit Retry | Multi-Format Proxy");

    const userAgents = readLinesFromFile(USER_AGENTS_FILE).filter(line => line.trim() !== '' && !line.startsWith('#'));
    if (userAgents.length === 0) {
        userAgents.push('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        logWarning("Using default user agent");
    }

    logSuccess(`Loaded ${userAgents.length} User-Agents`);

    const wallets = loadWalletsWithProxyMapping();
    if (wallets.length === 0) {
        logError("No valid wallets found");
        callback();
        return;
    }

    let successCount = 0;
    let failCount = 0;
    let limitCount = 0;
    let fakeSuccessCount = 0;
    let totalEarned = 0;
    let totalRetries = 0;

    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        
        console.log(chalk.blue(`🔄 Processing PK${wallet.originalLineNumber} [${i + 1}/${wallets.length}]`));
        console.log(chalk.gray(`   Address: ${wallet.address.slice(0, 42)}...`));
        console.log(chalk.gray(`   Proxy: ${wallet.proxyDisplay} (${wallet.proxyFormat})`));

        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        const result = await requestFaucetWithRateLimitRetry(wallet.address, randomUserAgent, wallet.proxy);
        
        if (result.successCount > 0) {
            successCount += result.successCount;
            totalEarned += result.totalEarned;
            console.log(chalk.green(`   📊 VERIFIED Results: ${result.successCount} real success, ${result.totalEarned.toFixed(6)} IOTA earned`));
        } else if (result.rateLimitRetries >= RATE_LIMIT_RETRY_ATTEMPTS) {
            limitCount++;
            console.log(chalk.yellow(`   ⚠️ Rate limited/No balance increase after ${result.rateLimitRetries} retries`));
        } else {
            failCount++;
            console.log(chalk.red(`   ❌ Failed after ${result.failedCount} attempts`));
        }

        if (result.fakeSuccessCount > 0) {
            fakeSuccessCount += result.fakeSuccessCount;
            console.log(chalk.yellow(`   ⚠️ Fake success detected: ${result.fakeSuccessCount} (response OK but no balance increase)`));
        }

        totalRetries += result.rateLimitRetries;
        
        if (i < wallets.length - 1) {
            console.log(chalk.gray(`   ⏱️ Next wallet in 5s...`));
            await sleep(5000);
        }
        logBlankLine();
    }

    // Final Results with verification info
    logSeparator('double');
    console.log(chalk.bold.green('📊 VERIFIED FAUCET RESULTS'));
    logSeparator('normal');
    console.log(chalk.green(`✅ REAL Success: ${successCount} (verified balance increase)`));
    console.log(chalk.yellow(`⚠️ Fake Success: ${fakeSuccessCount} (response OK but no IOTA received)`));
    console.log(chalk.red(`❌ Total Failed: ${failCount}`));
    console.log(chalk.yellow(`⚠️ Rate Limited: ${limitCount}`));
    console.log(chalk.blue(`🔁 Rate Limit Retries: ${totalRetries}`));
    console.log(chalk.magenta(`💰 ACTUAL Earned: ${totalEarned.toFixed(6)} IOTA (verified)`));
    const totalAttempts = successCount + failCount + limitCount + fakeSuccessCount;
    console.log(chalk.cyan(`📈 Real Success Rate: ${totalAttempts > 0 ? ((successCount / totalAttempts) * 100).toFixed(1) : 0}%`));

    if (fakeSuccessCount > 0) {
        console.log('');
        console.log(chalk.red('🚨 FAKE SUCCESS ANALYSIS:'));
        console.log(chalk.yellow(`   ${fakeSuccessCount} requests returned success but no balance increase`));
        console.log(chalk.yellow(`   This indicates rate limiting or already claimed wallets`));
        console.log(chalk.yellow(`   Only REAL success with balance increase is counted`));
    }

    globalFaucetStats = {
        totalSuccess: successCount,
        totalFailed: failCount,
        rateLimited: limitCount,
        fakeSuccess: fakeSuccessCount,
        totalRetries,
        totalEarned,
        completedAt: new Date().toISOString()
    };

    logBlankLine();
    logSuccess("Verified Auto Faucet completed!");
    callback();
}

// ===================================================================================
// CONTINUOUS FAUCET WITH 24H AUTO RESTART
// ===================================================================================
async function runContinuousFaucet() {
    isRunningContinuousFaucet = true;
    
    console.log(chalk.green('✅ Starting Continuous Faucet with Real Verification (24H auto restart)'));
    console.log(chalk.yellow('⚠️ Press Ctrl+C to stop'));
    await sleep(3000);

    let cycleCounter = 0;

    while (isRunningContinuousFaucet) {
        try {
            cycleCounter++;
            console.log(chalk.bold.blue(`🚰 Verified Faucet Cycle #${cycleCounter}`));
            
            await new Promise(resolve => {
                runEnhancedAutoFaucet(() => resolve());
            });
            
            if (!isRunningContinuousFaucet) break;
            
            nextFaucetRestartTime = calculateNextRunTime(FAUCET_RESTART_INTERVAL_HOURS);
            console.log(chalk.cyan(`⏰ Next cycle: ${nextFaucetRestartTime.toLocaleString()}`));
            
            await displayFaucetCountdown();
            
        } catch (error) {
            console.log(chalk.red(`❌ Cycle error: ${error.message}`));
            await sleep(60000);
        }
    }
    
    console.log(chalk.blue('ℹ️ Continuous faucet stopped'));
    return true;
}

async function displayFaucetCountdown() {
    return new Promise((resolve) => {
        const updateCountdown = () => {
            if (!isRunningContinuousFaucet) {
                resolve();
                return;
            }
            
            console.clear();
            console.log(chalk.bold.blue('🚀 CONTINUOUS FAUCET WITH REAL VERIFICATION - 24H AUTO RESTART'));
            console.log(chalk.cyan('🔍 Real Balance Check | Random Delay Retry: 10s-60s | Fixed Proxy URL Support'));
            console.log(chalk.cyan('═'.repeat(80)));
            
            const now = new Date().getTime();
            const distance = nextFaucetRestartTime.getTime() - now;
            
            if (distance <= 0) {
                clearInterval(faucetCountdownInterval);
                resolve();
                return;
            }
            
            const countdown = formatCountdownTime(distance);
            console.log(chalk.bold.green(`⏰ Next cycle in: ${countdown}`));
            console.log('');
            
            if (globalFaucetStats.totalSuccess) {
                console.log(chalk.cyan('📊 Last cycle results:'));
                console.log(chalk.green(`   REAL Success: ${globalFaucetStats.totalSuccess} (verified)`));
                console.log(chalk.yellow(`   ACTUAL Earned: ${globalFaucetStats.totalEarned.toFixed(6)} IOTA`));
                console.log(chalk.blue(`   Retries: ${globalFaucetStats.totalRetries}`));
                console.log(chalk.red(`   Rate Limited: ${globalFaucetStats.rateLimited}`));
                if (globalFaucetStats.fakeSuccess > 0) {
                    console.log(chalk.yellow(`   Fake Success: ${globalFaucetStats.fakeSuccess} (no balance increase)`));
                }
            }
            
            console.log('');
            console.log(chalk.gray('🔍 Verification: Check balance before/after each faucet request'));
            console.log(chalk.gray('🎲 Random delay: 10-60 seconds between retries'));
            console.log(chalk.gray('🔧 Proxy URL format: http://user:pass@host:port'));
            console.log(chalk.gray('Press Ctrl+C to stop'));
        };

        updateCountdown();
        faucetCountdownInterval = setInterval(updateCountdown, 1000);
    });
}

// ===================================================================================
// CIRCULAR WALLET PROCESSING FOR MENU 5 (SAME AS BEFORE)
// ===================================================================================
async function executeCircularWalletProcessing(wallets, validators) {
    console.log(chalk.blue(`🚀 CIRCULAR WALLET PROCESSING (MENU 5)`));
    console.log(chalk.cyan(`Processing ${wallets.length} wallets in circular pattern:`));
    console.log(chalk.cyan(`- PK1 → 2 transfers to PK2`));
    console.log(chalk.cyan(`- PK2 → 2 transfers to PK3`));
    console.log(chalk.cyan(`- ...`));
    console.log(chalk.cyan(`- PK${wallets.length} → 2 transfers to PK1`));
    console.log(chalk.cyan(`- Staking to ALL validators after each wallet's transfers`));
    console.log(chalk.cyan(`- Target total: ${TOTAL_TRANSFERS_EXPECTED} transfers`));
    logBlankLine();

    let totalTransferStats = {
        success: 0,
        failed: 0,
        totalTransferred: 0
    };

    let totalStakingStats = {
        success: 0,
        failed: 0,
        totalStaked: 0
    };

    // Process each wallet in circular pattern
    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
        const currentWallet = wallets[walletIndex];
        
        // Calculate target wallet (circular: next wallet, or back to first if last)
        const targetWalletIndex = (walletIndex + 1) % wallets.length;
        const targetWallet = wallets[targetWalletIndex];
        
        console.log(chalk.yellow(`┌─ PROCESSING WALLET PK${currentWallet.originalLineNumber} [${walletIndex + 1}/${wallets.length}] ─┐`));
        console.log(chalk.white(`│ From: PK${currentWallet.originalLineNumber} (${currentWallet.address.slice(0, 42)}...)`));
        console.log(chalk.white(`│ To:   PK${targetWallet.originalLineNumber} (${targetWallet.address.slice(0, 42)}...)`));
        console.log(chalk.cyan(`│ Proxy: ${currentWallet.proxyDisplay} (${currentWallet.proxyFormat})`));
        console.log(chalk.yellow(`└${'─'.repeat(75)}┘`));
        logBlankLine();

        // PHASE 1: Execute 2 transfers from current wallet to target wallet
        console.log(chalk.magenta(`📤 PHASE 1: TRANSFERS PK${currentWallet.originalLineNumber} → PK${targetWallet.originalLineNumber}`));
        
        for (let transferIndex = 0; transferIndex < TRANSFERS_PER_WALLET_SEQUENTIAL; transferIndex++) {
            const transferAmount = generateRandomAmount();
            const transferAmountNanos = BigInt(Math.floor(transferAmount * Number(NANOS_PER_IOTA)));

            console.log(chalk.blue(`💸 TRANSFER [${transferIndex + 1}/${TRANSFERS_PER_WALLET_SEQUENTIAL}]`));
            console.log(chalk.white(`   Amount: ${transferAmount} IOTA`));
            console.log(chalk.white(`   From: PK${currentWallet.originalLineNumber}`));
            console.log(chalk.white(`   To: PK${targetWallet.originalLineNumber}`));
            console.log(chalk.gray(`   Pattern: Circular ${walletIndex + 1}→${targetWalletIndex + 1}`));

            try {
                const balanceResponse = await iotaClient.getBalance({ owner: currentWallet.address });
                const totalBalanceNanos = BigInt(balanceResponse.totalBalance);
                const requiredAmountNanos = transferAmountNanos + GAS_FEE_BUFFER_NANOS;
                const currentBalance = parseFloat(totalBalanceNanos.toString()) / Number(NANOS_PER_IOTA);

                if (totalBalanceNanos >= requiredAmountNanos) {
                    const tx = new Transaction();
                    const [coin] = tx.splitCoins(tx.gas, [transferAmountNanos]);
                    tx.transferObjects([coin], targetWallet.address);

                    const outcome = await executeTransactionWithRetries(currentWallet.keypair, tx);

                    if (outcome.success) {
                        totalTransferStats.success++;
                        totalTransferStats.totalTransferred += transferAmount;
                        console.log(chalk.green('✅ TRANSFER SUCCESS'));
                        console.log(chalk.gray(`   Digest: ${outcome.result.digest.slice(0, 32)}...`));
                        console.log(chalk.green(`   Progress: ${totalTransferStats.success}/${TOTAL_TRANSFERS_EXPECTED} transfers completed`));
                    } else {
                        totalTransferStats.failed++;
                        console.log(chalk.red('❌ TRANSFER FAILED'));
                        console.log(chalk.red(`   Error: ${outcome.error.message.slice(0, 50)}...`));
                    }
                } else {
                    totalTransferStats.failed++;
                    console.log(chalk.red('❌ TRANSFER FAILED'));
                    console.log(chalk.yellow(`   Insufficient balance: ${currentBalance.toFixed(6)} IOTA`));
                    console.log(chalk.yellow(`   Required: ${(Number(requiredAmountNanos) / Number(NANOS_PER_IOTA)).toFixed(6)} IOTA`));
                }
            } catch (error) {
                totalTransferStats.failed++;
                console.log(chalk.red('❌ TRANSFER FAILED'));
                console.log(chalk.red(`   Error: ${error.message.slice(0, 50)}...`));
            }

            // Delay between transfers
            if (transferIndex < TRANSFERS_PER_WALLET_SEQUENTIAL - 1) {
                const delay = generateRandomDelay();
                console.log(chalk.gray(`   ⏱️ Transfer delay: ${Math.round(delay / 1000)}s`));
                await sleep(delay);
            }
            logBlankLine();
        }

        // PHASE 2: Staking for current wallet (optional)
        if (validators.length > 0) {
            console.log(chalk.magenta(`🔒 PHASE 2: STAKING FOR WALLET PK${currentWallet.originalLineNumber}`));
            console.log(chalk.cyan(`   Staking to ${validators.length} validators`));
            logBlankLine();

            const phaseTransitionDelay = Math.floor(Math.random() * 5000) + 3000;
            console.log(chalk.gray(`   ⏱️ Phase transition delay: ${Math.round(phaseTransitionDelay / 1000)}s`));
            await sleep(phaseTransitionDelay);

            // Stake to all validators using current wallet
            for (let validatorIndex = 0; validatorIndex < validators.length; validatorIndex++) {
                const validator = validators[validatorIndex];
                const stakeAmount = generateRandomStakeAmount();

                console.log(chalk.blue(`🔒 STAKING [${validatorIndex + 1}/${validators.length}] - PK${currentWallet.originalLineNumber}`));
                console.log(chalk.white(`   Wallet: PK${currentWallet.originalLineNumber}`));
                console.log(chalk.white(`   Validator: ${validator.slice(0, 20)}...${validator.slice(-10)}`));
                console.log(chalk.white(`   Amount: ${stakeAmount} IOTA`));

                try {
                    const balanceResponse = await iotaClient.getBalance({ owner: currentWallet.address });
                    const currentBalance = parseFloat(balanceResponse.totalBalance) / Number(NANOS_PER_IOTA);

                    if (currentBalance < stakeAmount + 0.1) {
                        totalStakingStats.failed++;
                        console.log(chalk.red('❌ STAKING FAILED'));
                        console.log(chalk.yellow(`   Insufficient balance: ${currentBalance.toFixed(6)} IOTA`));
                        console.log(chalk.yellow(`   Required: ${(stakeAmount + 0.1).toFixed(6)} IOTA (including gas)`));
                    } else {
                        const tx = new Transaction();
                        const stakeAmountNanos = BigInt(Math.floor(stakeAmount * Number(NANOS_PER_IOTA)));
                        const [stakeCoin] = tx.splitCoins(tx.gas, [stakeAmountNanos]);

                        tx.moveCall({
                            target: '0x3::iota_system::request_add_stake',
                            arguments: [
                                tx.object('0x5'),
                                stakeCoin,
                                tx.pure.address(validator)
                            ],
                        });

                        const outcome = await executeTransactionWithRetries(currentWallet.keypair, tx);

                        if (outcome.success) {
                            totalStakingStats.success++;
                            totalStakingStats.totalStaked += stakeAmount;
                            console.log(chalk.green('✅ STAKING SUCCESS'));
                            console.log(chalk.gray(`   Digest: ${outcome.result.digest.slice(0, 32)}...`));
                        } else {
                            totalStakingStats.failed++;
                            console.log(chalk.red('❌ STAKING FAILED'));
                            console.log(chalk.red(`   Error: ${outcome.error.message.slice(0, 50)}...`));
                        }
                    }
                } catch (error) {
                    totalStakingStats.failed++;
                    console.log(chalk.red('❌ STAKING FAILED'));
                    console.log(chalk.red(`   Error: ${error.message.slice(0, 50)}...`));
                }

                // Delay between stakes
                if (validatorIndex < validators.length - 1) {
                    const stakeDelay = Math.floor(Math.random() * 3000) + 2000;
                    console.log(chalk.gray(`   ⏱️ Stake delay: ${Math.round(stakeDelay / 1000)}s`));
                    await sleep(stakeDelay);
                }
                logBlankLine();
            }
        }

        // Wallet completion summary
        console.log(chalk.green(`✅ WALLET PK${currentWallet.originalLineNumber} COMPLETED`));
        console.log(chalk.cyan(`   Transfers: ${TRANSFERS_PER_WALLET_SEQUENTIAL} to PK${targetWallet.originalLineNumber}`));
        console.log(chalk.cyan(`   Stakes: ${validators.length} attempts`));
        console.log(chalk.cyan(`   Circular Progress: ${walletIndex + 1}/${wallets.length} wallets processed`));
        
        // Show next wallet in circular pattern
        if (walletIndex < wallets.length - 1) {
            const nextWallet = wallets[walletIndex + 1];
            const nextTarget = wallets[(walletIndex + 2) % wallets.length];
            console.log(chalk.gray(`   🔄 Next: PK${nextWallet.originalLineNumber} → PK${nextTarget.originalLineNumber}`));
            
            const walletDelay = generateRandomDelay();
            console.log(chalk.gray(`   ⏱️ Next wallet in ${Math.round(walletDelay / 1000)}s...`));
            await sleep(walletDelay);
        }

        logSeparator('normal');
        logBlankLine();
    }

    return {
        transferStats: totalTransferStats,
        stakingStats: totalStakingStats
    };
}

// ===================================================================================
// CIRCULAR AUTOMATED CYCLE (MENU 5)
// ===================================================================================
async function runCircularAutomatedCycle(config) {
    logHeader("CIRCULAR AUTOMATED CYCLE (MENU 5)", `Started at ${getCurrentTimestamp()}`);

    const wallets = loadWalletsWithProxyMapping();
    if (wallets.length === 0) {
        logError("No valid wallets found for circular processing");
        return false;
    }

    const validators = getValidators();
    if (config.autoLoop.enableStaking && validators.length === 0) {
        logWarning("No validators found, disabling staking for this cycle");
        config.autoLoop.enableStaking = false;
    }

    // Calculate expected totals
    const expectedTransfers = wallets.length * TRANSFERS_PER_WALLET_SEQUENTIAL;
    const expectedStakes = config.autoLoop.enableStaking ? wallets.length * validators.length : 0;

    logInfo("Circular Cycle Configuration");
    console.log(chalk.cyan(`   Processing Mode: Circular (PK1→PK2→PK3→...→PK1)`));
    console.log(chalk.cyan(`   Wallets: ${wallets.length}`));
    console.log(chalk.cyan(`   Transfers per wallet: ${TRANSFERS_PER_WALLET_SEQUENTIAL}`));
    console.log(chalk.cyan(`   Expected total transfers: ${expectedTransfers}`));
    console.log(chalk.cyan(`   Target transfers: ${TOTAL_TRANSFERS_EXPECTED}`));
    console.log(chalk.cyan(`   Validators: ${validators.length}`));
    console.log(chalk.cyan(`   Expected total stakes: ${expectedStakes}`));
    console.log(chalk.cyan(`   Staking enabled: ${config.autoLoop.enableStaking ? 'YES' : 'NO'}`));
    logBlankLine();

    // Show circular pattern preview
    console.log(chalk.blue('🔄 Circular Transfer Pattern:'));
    for (let i = 0; i < Math.min(wallets.length, 5); i++) {
        const from = wallets[i];
        const to = wallets[(i + 1) % wallets.length];
        console.log(chalk.gray(`   PK${from.originalLineNumber} → 2 transfers → PK${to.originalLineNumber}`));
    }
    if (wallets.length > 5) {
        console.log(chalk.gray(`   ... (${wallets.length - 5} more wallets)`));
        const lastWallet = wallets[wallets.length - 1];
        const firstWallet = wallets[0];
        console.log(chalk.gray(`   PK${lastWallet.originalLineNumber} → 2 transfers → PK${firstWallet.originalLineNumber} (back to start)`));
    }
    logBlankLine();

    const cycleStartTime = Date.now();

    // Execute circular wallet processing
    const results = await executeCircularWalletProcessing(wallets, config.autoLoop.enableStaking ? validators : []);

    const cycleEndTime = Date.now();
    const cycleDurationMinutes = Math.round((cycleEndTime - cycleStartTime) / 60000);

    // Update config
    config.autoLoop.lastRun = new Date().toISOString();
    saveConfig(config);

    // Final Statistics
    logHeader("CIRCULAR CYCLE COMPLETE", `Finished at ${getCurrentTimestamp()} | Duration: ${cycleDurationMinutes} minutes`);
    
    console.log(chalk.bold.cyan('📊 CIRCULAR TRANSFER RESULTS'));
    console.log(chalk.green(`✅ Success: ${results.transferStats.success}/${expectedTransfers} (${((results.transferStats.success / expectedTransfers) * 100).toFixed(1)}%)`));
    console.log(chalk.red(`❌ Failed: ${results.transferStats.failed}`));
    console.log(chalk.blue(`💰 Total Transferred: ${results.transferStats.totalTransferred.toFixed(6)} IOTA`));
    console.log(chalk.yellow(`🎯 Target Achievement: ${results.transferStats.success >= TOTAL_TRANSFERS_EXPECTED ? 'TARGET MET!' : `${results.transferStats.success}/${TOTAL_TRANSFERS_EXPECTED}`}`));
    console.log(chalk.magenta(`🔄 Pattern: Circular (PK1→PK2→...→PK1)`));

    if (config.autoLoop.enableStaking) {
        logBlankLine();
        console.log(chalk.bold.cyan('📊 CIRCULAR STAKING RESULTS'));
        console.log(chalk.green(`✅ Success: ${results.stakingStats.success}/${expectedStakes} (${expectedStakes > 0 ? ((results.stakingStats.success / expectedStakes) * 100).toFixed(1) : 0}%)`));
        console.log(chalk.red(`❌ Failed: ${results.stakingStats.failed}`));
        console.log(chalk.blue(`🔒 Total Staked: ${results.stakingStats.totalStaked.toFixed(6)} IOTA`));
    }

    const nextRun = new Date(Date.now() + (config.autoLoop.intervalHours * HOURS_1_MS));
    logInfo("Next Circular Cycle", nextRun.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }));

    globalCycleStats = {
        transferStats: results.transferStats,
        stakingStats: results.stakingStats,
        completedAt: new Date().toISOString(),
        duration: cycleDurationMinutes,
        walletsProcessed: wallets.length,
        validatorsUsed: validators.length,
        processingMode: 'circular',
        expectedTransfers: expectedTransfers,
        expectedStakes: expectedStakes
    };

    return true;
}

// ===================================================================================
// CIRCULAR ENHANCED AUTO LOOP (MENU 5)
// ===================================================================================
async function runCircularEnhancedAutoLoop() {
    isRunningFullCycle = true;
    
    console.log(chalk.green('✅ Starting Circular Enhanced Auto Loop (Menu 5)'));
    console.log(chalk.cyan('🔄 Processing Mode: Circular (PK1→PK2→PK3→...→PK1)'));
    console.log(chalk.magenta('🎲 Random delay retry: 10s-60s | Fixed proxy URL format'));
    console.log(chalk.yellow('⚠️ Press Ctrl+C to stop'));
    
    const config = loadConfig();
    let cycleCounter = 0;

    while (isRunningFullCycle) {
        try {
            cycleCounter++;
            console.log(chalk.bold.blue(`🔄 Circular Enhanced Auto Loop Cycle #${cycleCounter}`));
            console.log(chalk.gray(`   Mode: Circular pattern (PK1→PK2→...→PK26→PK1)`));
            
            const cycleSuccess = await runCircularAutomatedCycle(config);
            
            if (!isRunningFullCycle) break;
            
            if (cycleSuccess) {
                console.log(chalk.bold.green(`✅ Circular Cycle #${cycleCounter} completed successfully!`));
                if (globalCycleStats.transferStats && globalCycleStats.transferStats.success >= TOTAL_TRANSFERS_EXPECTED) {
                    console.log(chalk.bold.green(`🎯 TARGET ACHIEVED: ${globalCycleStats.transferStats.success}/${TOTAL_TRANSFERS_EXPECTED} transfers completed!`));
                }
            } else {
                console.log(chalk.red(`❌ Circular Cycle #${cycleCounter} failed`));
            }
            
            nextRunTime = calculateNextRunTime(config.autoLoop.intervalHours);
            console.log(chalk.cyan(`⏰ Next circular cycle: ${nextRunTime.toLocaleString()}`));
            
            await displayCircularAutoLoopCountdown(config, cycleCounter);
            
        } catch (error) {
            console.log(chalk.red(`❌ Circular cycle error: ${error.message}`));
            await sleep(60000);
        }
    }
    
    console.log(chalk.blue('ℹ️ Circular Enhanced Auto Loop stopped'));
    return true;
}

// ===================================================================================
// CIRCULAR COUNTDOWN (MENU 5)
// ===================================================================================
async function displayCircularAutoLoopCountdown(config, cycleNumber) {
    return new Promise((resolve) => {
        const updateCountdown = () => {
            if (!isRunningFullCycle) {
                resolve();
                return;
            }
            
            console.clear();
            console.log(chalk.bold.blue('🚀 CIRCULAR ENHANCED AUTO LOOP (MENU 5)'));
            console.log(chalk.cyan('🔄 Circular Pattern: PK1→PK2→PK3→...→PK26→PK1'));
            console.log(chalk.magenta('🎲 Random Delay: 10s-60s | Fixed Proxy URL: http://user:pass@host:port'));
            console.log(chalk.cyan('═'.repeat(75)));
            
            const now = new Date().getTime();
            const distance = nextRunTime.getTime() - now;
            
            if (distance <= 0) {
                clearInterval(countdownInterval);
                resolve();
                return;
            }
            
            const countdown = formatCountdownTime(distance);
            console.log(chalk.bold.green(`⏰ Next circular cycle in: ${countdown}`));
            console.log('');
            console.log(chalk.cyan(`Network: ${selectedNetwork.toUpperCase()}`));
            console.log(chalk.cyan(`Interval: ${config.autoLoop.intervalHours} hours`));
            console.log(chalk.cyan(`Processing Mode: Circular (PK1→PK2→...→PK1)`));
            console.log(chalk.cyan(`Transfers per wallet: ${TRANSFERS_PER_WALLET_SEQUENTIAL}`));
            console.log(chalk.cyan(`Target total transfers: ${TOTAL_TRANSFERS_EXPECTED}`));
            console.log(chalk.cyan(`Staking: ${config.autoLoop.enableStaking ? 'ON (all validators per wallet)' : 'OFF'}`));
            console.log(chalk.cyan(`Completed Cycles: ${cycleNumber}`));
            
            if (globalCycleStats && globalCycleStats.transferStats) {
                console.log('');
                console.log(chalk.yellow('📊 Last Circular Cycle Results:'));
                console.log(chalk.green(`   Transfers: ${globalCycleStats.transferStats.success}/${globalCycleStats.expectedTransfers} success`));
                if (globalCycleStats.stakingStats) {
                    console.log(chalk.blue(`   Stakes: ${globalCycleStats.stakingStats.success}/${globalCycleStats.expectedStakes} success`));
                }
                console.log(chalk.gray(`   Duration: ${globalCycleStats.duration} minutes`));
                console.log(chalk.gray(`   Wallets: ${globalCycleStats.walletsProcessed} processed`));
                if (globalCycleStats.transferStats.success >= TOTAL_TRANSFERS_EXPECTED) {
                    console.log(chalk.bold.green(`   🎯 TARGET ACHIEVED: ${globalCycleStats.transferStats.success}/${TOTAL_TRANSFERS_EXPECTED}`));
                }
            }
            
            console.log('');
            console.log(chalk.gray('🔄 Circular Flow: PK1(2tx→PK2,stake) → PK2(2tx→PK3,stake) → ... → PK26(2tx→PK1,stake)'));
            console.log(chalk.gray('🎲 Random delays: Rate limit retry 10-60s | Transfer delay 10-30s'));
            console.log(chalk.gray('🔧 Proxy support: http://user:pass@host:port format fixed'));
            console.log(chalk.gray('Press Ctrl+C to stop'));
        };

        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
    });
}

// ===================================================================================
// CIRCULAR CONFIGURATION (MENU 5)
// ===================================================================================
async function configureCircularAutoLoop(callback) {
    console.clear();
    logHeader("CIRCULAR AUTO LOOP CONFIGURATION (MENU 5)", "Enhanced Circular Settings");

    const config = loadConfig();

    logInfo("Circular Processing Configuration");
    console.log(chalk.cyan("   Enabled: ") + (config.autoLoop.enabled ? chalk.green('Yes') : chalk.red('No')));
    console.log(chalk.cyan("   Interval: ") + chalk.yellow(config.autoLoop.intervalHours + ' hours'));
    console.log(chalk.cyan("   Processing Mode: ") + chalk.magenta('Circular (PK1→PK2→...→PK1)'));
    console.log(chalk.cyan("   Transfers per wallet: ") + chalk.yellow(TRANSFERS_PER_WALLET_SEQUENTIAL + ' transfers'));
    console.log(chalk.cyan("   Target total transfers: ") + chalk.green(TOTAL_TRANSFERS_EXPECTED + ' transfers'));
    console.log(chalk.cyan("   Staking: ") + (config.autoLoop.enableStaking ? chalk.green('Enabled (all validators per wallet)') : chalk.red('Disabled')));
    console.log(chalk.cyan("   Retry delay: ") + chalk.magenta('Random 10-60 seconds'));

    if (config.autoLoop.lastRun) {
        console.log(chalk.cyan("   Last run: ") + chalk.gray(new Date(config.autoLoop.lastRun).toLocaleString('id-ID')));
    }

    logBlankLine();
    console.log(chalk.blue('🔄 Circular Flow:'));
    console.log(chalk.gray('   1. PK1 → 2 transfers to PK2 → stake to ALL validators'));
    console.log(chalk.gray('   2. PK2 → 2 transfers to PK3 → stake to ALL validators'));
    console.log(chalk.gray('   3. Continue until PK26 → 2 transfers to PK1'));
    console.log(chalk.gray('   4. Wait 24 hours → repeat entire circular cycle'));
    console.log(chalk.blue('🎲 Enhanced Features:'));
    console.log(chalk.gray('   • Random retry delay: 10-60 seconds'));
    console.log(chalk.gray('   • Fixed proxy URL format: http://user:pass@host:port'));
    console.log(chalk.gray('   • Target achievement tracking: 52 transfers'));
    logBlankLine();

    rl.question(chalk.yellow("Enable Circular Enhanced Auto Loop? (y/n): "), (enabled) => {
        config.autoLoop.enabled = enabled.toLowerCase() === 'y';

        if (!config.autoLoop.enabled) {
            saveConfig(config);
            logInfo("Circular auto loop disabled");
            callback();
            return;
        }

        rl.question(chalk.yellow("Interval hours (default 24): "), (hours) => {
            const intervalHours = hours.trim() === '' ? 24 : parseInt(hours);
            if (isNaN(intervalHours) || intervalHours < 1) {
                logError("Invalid interval!");
                callback();
                return;
            }

            config.autoLoop.intervalHours = intervalHours;

            rl.question(chalk.yellow("Enable circular staking (all validators per wallet)? (y/n): "), (staking) => {
                config.autoLoop.enableStaking = staking.toLowerCase() === 'y';

                if (saveConfig(config)) {
                    logSuccess("Circular configuration saved successfully!");
                    logInfo("Final Circular Configuration");
                    console.log(chalk.cyan("   Mode: ") + chalk.magenta('Circular Processing (Menu 5)'));
                    console.log(chalk.cyan("   Pattern: ") + chalk.blue('PK1→PK2→PK3→...→PK26→PK1'));
                    console.log(chalk.cyan("   Transfers: ") + chalk.yellow('2 per wallet (circular target)'));
                    console.log(chalk.cyan("   Target: ") + chalk.green(TOTAL_TRANSFERS_EXPECTED + ' total transfers'));
                    console.log(chalk.cyan("   Staking: ") + (config.autoLoop.enableStaking ? chalk.green('All validators per wallet after transfers') : chalk.red('Disabled')));

                    logBlankLine();
                    rl.question(chalk.yellow("Start circular enhanced auto loop now? (y/n): "), (start) => {
                        if (start.toLowerCase() === 'y') {
                            runCircularEnhancedAutoLoop();
                        }
                        callback();
                    });
                } else {
                    callback();
                }
            });
        });
    });
}

// ===================================================================================
// MAIN MENU WITH REAL FAUCET VERIFICATION
// ===================================================================================
function showMenu() {
    const config = loadConfig();
    console.clear();
    
    logHeader("IOTA Wallet Manager v2.5", "Super Minimal Balance | Circular Processing | REAL Faucet Verification | Fixed Proxy URL");

    const network = selectedNetwork.toUpperCase() === 'MAINNET' ?
        chalk.red.bold(selectedNetwork.toUpperCase()) :
        chalk.yellow(selectedNetwork.toUpperCase());

    const autoLoopStatus = isRunningFullCycle ?
        chalk.green('🟢 RUNNING (Circular)') :
        (config.autoLoop.enabled ? chalk.yellow('🟡 ENABLED') : chalk.red('🔴 DISABLED'));

    const faucetStatus = isRunningContinuousFaucet ?
        chalk.green('🟢 RUNNING (Verified)') :
        chalk.red('🔴 STOPPED');

    console.log(chalk.cyan("📍 System Status:"));
    console.log(chalk.cyan(`   Network: ${network}`));
    console.log(chalk.cyan(`   Circular Auto Loop: ${autoLoopStatus}`));
    console.log(chalk.cyan(`   Continuous Faucet: ${faucetStatus}`));
    console.log(chalk.cyan(`   Time: ${getCurrentTimestamp()}`));

    logBlankLine();
    logSeparator('normal');
    console.log(chalk.bold.white("🎯 Available Options:"));
    logBlankLine();
    console.log(" 1. 💰 Check Balance (Super Minimal)");
    console.log(" 2. 🚰 Enhanced Auto Faucet (REAL Verification)");
    console.log(` 3. 🔄 ${isRunningContinuousFaucet ? 'Stop' : 'Start'} Continuous Faucet (24H + Verified)`);
    console.log(" 4. ⚙️  Configure Circular Auto Loop");
    console.log(` 5. 🔄 ${isRunningFullCycle ? 'Stop' : 'Start'} Circular Auto Loop (PK1→PK2→...→PK1)`);
    console.log(" 6. 🌐 Change Network");
    console.log(" 7. 🚪 Exit");
    logBlankLine();
    logSeparator('dotted');
    console.log(chalk.gray(`🔄 Circular Config: PK1→PK2→PK3→...→PK26→PK1 (2tx each) → staking → 24h repeat`));
    console.log(chalk.gray(`🔍 Faucet Verification: Check balance before/after each request | Only real success counted`));
    logSeparator('dotted');
    logBlankLine();

    rl.question(chalk.yellow("Select option (1-7): "), (choice) => {
        switch (choice.trim()) {
            case '1':
                checkBalancesMinimal(showMenu); // SUPER MINIMAL VERSION
                break;
            case '2':
                runEnhancedAutoFaucet(showMenu); // REAL VERIFICATION VERSION
                break;
            case '3':
                if (isRunningContinuousFaucet) {
                    isRunningContinuousFaucet = false;
                    if (faucetCountdownInterval) {
                        clearInterval(faucetCountdownInterval);
                        faucetCountdownInterval = null;
                    }
                    console.log(chalk.green('✅ Continuous verified faucet stopped'));
                    setTimeout(showMenu, 2000);
                } else {
                    runContinuousFaucet().then(showMenu); // VERIFIED VERSION
                }
                break;
            case '4':
                configureCircularAutoLoop(showMenu); // CIRCULAR CONFIG
                break;
            case '5':
                if (isRunningFullCycle) {
                    isRunningFullCycle = false;
                    if (countdownInterval) {
                        clearInterval(countdownInterval);
                        countdownInterval = null;
                    }
                    console.log(chalk.green('✅ Circular enhanced auto loop stopped'));
                    setTimeout(showMenu, 2000);
                } else {
                    runCircularEnhancedAutoLoop().then(showMenu); // CIRCULAR VERSION
                }
                break;
            case '6':
                if (isRunningContinuousFaucet || isRunningFullCycle) {
                    console.log(chalk.red('❌ Stop running operations first'));
                    setTimeout(showMenu, 2000);
                } else {
                    logInfo("Returning to network selection...");
                    start();
                }
                break;
            case '7':
                if (isRunningContinuousFaucet) {
                    logInfo("Stopping continuous faucet before exit...");
                    isRunningContinuousFaucet = false;
                }
                if (isRunningFullCycle) {
                    logInfo("Stopping circular enhanced auto loop before exit...");
                    isRunningFullCycle = false;
                }
                logInfo("Goodbye! 👋");
                rl.close();
                break;
            default:
                logError("Invalid option!");
                showMenu();
                break;
        }
    });
}

// ===================================================================================
// NETWORK SELECTION
// ===================================================================================
function selectNetwork() {
    return new Promise(resolve => {
        const showPrompt = () => {
            console.clear();
            logHeader("NETWORK SELECTION", "Choose IOTA Network");

            console.log(chalk.cyan("Available Networks:"));
            console.log(` 1. Mainnet ${chalk.red.bold('(REAL MONEY - BE VERY CAREFUL!')}`);
            console.log(` 2. Testnet ${chalk.green.bold('(SAFE FOR TESTING)')}`);
            console.log(` 3. Devnet ${chalk.blue.bold('(DEVELOPMENT NETWORK)')}`);
            logBlankLine();

            rl.question(chalk.yellow("Select network (1-3): "), (choice) => {
                if (choice.trim() === '1') {
                    logWarning("MAINNET SELECTED", "ALL TRANSACTIONS USE REAL MONEY!");
                    resolve('mainnet');
                } else if (choice.trim() === '2') {
                    logSuccess("Testnet selected", "Safe environment for testing");
                    resolve('testnet');
                } else if (choice.trim() === '3') {
                    logSuccess("Devnet selected", "Development network environment");
                    resolve('devnet');
                } else {
                    logError("Invalid choice", "Please try again");
                    showPrompt();
                }
            });
        };
        showPrompt();
    });
}

// ===================================================================================
// APPLICATION STARTUP
// ===================================================================================
async function start() {
    console.clear();
    logHeader("IOTA WALLET MANAGER", "v2.5 - Super Minimal Balance | Circular Processing | REAL Faucet Verification | Fixed Proxy URL");

    console.log(chalk.green("🚀 Enhanced Features:"));
    console.log(chalk.cyan("   📝 Support: iotaprivkey1... (Bech32) & hex formats"));
    console.log(chalk.magenta("   💰 Menu 1: Super minimal balance check (local IP only)"));
    console.log(chalk.blue("   🔄 Menu 5: Circular processing (PK1→PK2→...→PK26→PK1)"));
    console.log(chalk.red("   🔒 Multi-staking: 1 stake per validator (1-3 IOTA random)"));
    console.log(chalk.yellow("   ⏱️ Smart delays: 10-30s transfers | 10-60s retry"));
    console.log(chalk.green("   🔗 Fixed Proxy: http://user:pass@host:port format support"));
    console.log(chalk.cyan("   🎲 Random retry: 10-60 seconds rate limit retry"));
    console.log(chalk.magenta("   🎯 Target: 52 total transfers with progress tracking"));
    console.log(chalk.red("   🔍 FAUCET: Real balance verification (before/after check)"));

    try {
        selectedNetwork = await selectNetwork();
        iotaClient = new IotaClient({ url: getFullnodeUrl(selectedNetwork) });

        logSuccess(`Connected to IOTA ${selectedNetwork}`);

        const config = loadConfig();
        if (config.autoLoop.enabled) {
            logInfo("Circular enhanced auto loop enabled in config, ready to run");
        }

        showMenu();
    } catch (error) {
        logError("Initialization failed", error.message);
        logInfo("Retrying in 2 seconds...");
        setTimeout(start, 2000);
    }
}

// Handle process interruption
process.on('SIGINT', () => {
    logInfo("Program interrupted");
    if (isRunningContinuousFaucet) {
        logInfo("Stopping continuous faucet");
        isRunningContinuousFaucet = false;
    }
    if (isRunningFullCycle) {
        logInfo("Stopping circular enhanced auto loop");
        isRunningFullCycle = false;
    }
    logInfo("Program terminated. Goodbye!");
    rl.close();
    process.exit(0);
});

// Start the application
start();
