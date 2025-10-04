/**
 * IOTA Wallet Manager v2.5 - RESPONSIVE MULTI-VALIDATOR STAKING
 * =============================================================
 * Fixed: Bot tetap responsive dan bisa kembali ke menu setelah start loop
 */

const chalk = require('chalk');
const { IotaClient, getFullnodeUrl } = require('@iota/iota-sdk/client');
const { Ed25519Keypair } = require('@iota/iota-sdk/keypairs/ed25519');
const { Transaction } = require('@iota/iota-sdk/transactions');
const { decodeIotaPrivateKey } = require('@iota/iota-sdk/cryptography');
const { getFaucetHost, requestIotaFromFaucetV1 } = require('@iota/iota-sdk/faucet');
const { NANOS_PER_IOTA } = require('@iota/iota-sdk/utils');
const fs = require('fs');
const readline = require('readline');
const { ProxyAgent } = require('undici');
const https = require('https');

// ===================================================================================
// KONFIGURASI
// ===================================================================================
const PK_FILE = 'pk.txt';
const VALIDATORS_FILE = 'validators.txt';
const CONFIG_FILE = 'config.json';
const USER_AGENTS_FILE = 'user_agents.txt';
const PROXY_FILE = 'proxy.txt';
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

const DEFAULT_TESTNET_VALIDATORS = [
    '0x1c6b89f4d5ee1af5d0b9c0f67f7c8e4a2b1a3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    '0x2d7c9a5f6e7a1b6f5d0c9b8f6e7a1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    '0x3e8d0b6f7e8a2c7f6e1d0c9b8f6e7a2d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a1c'
];

const FAUCET_LIMIT_PATTERNS = [
    'rate limit', 'too many requests', 'limit exceeded', 'already claimed',
    'wait before', 'cooldown', 'try again later', 'quota exceeded',
    'maximum requests', 'throttled', '429', 'already received',
    'claim limit', 'daily limit'
];

// ===================================================================================
// GLOBAL VARIABLES
// ===================================================================================
let iotaClient;
let selectedNetwork;
let autoLoopInterval = null;
let isAutoLoopRunning = false;
let currentCyclePromise = null; // Track current cycle promise
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===================================================================================
// CLEAN OUTPUT SYSTEM
// ===================================================================================
let accountResults = {};
let sessionStartTime = new Date();

function formatTimestamp() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}.${minutes}.${seconds}`;
}

function formatSessionTime() {
    const sessionSeconds = Math.floor((new Date() - sessionStartTime) / 1000);
    return `+${sessionSeconds}s`;
}

function updateStatus(message) {
    process.stdout.write('\x1Bc'); // Clear console completely
    console.log(chalk.bold.blue('🚀 IOTA WALLET MANAGER V2.5'));
    console.log(chalk.cyan('MULTI-VALIDATOR STAKING | Stake to ALL Validators'));
    console.log(chalk.cyan('═'.repeat(80)));
    console.log('');
    console.log(chalk.yellow('📍 System Status:'));
    console.log(chalk.cyan(` Network: ${selectedNetwork.toUpperCase()}`));
    console.log(chalk.cyan(` Auto Loop: 🟢 RUNNING`));
    console.log(chalk.cyan(` Flow: Transfer → Multi-Validator Staking`));
    console.log(chalk.cyan(` Staking: 1x per validator (1-3 IOTA each)`));
    console.log(chalk.cyan(` Time: ${formatTimestamp()}`));
    console.log('');
    console.log(chalk.cyan('─'.repeat(80)));
    console.log('');
    console.log(chalk.magenta(message));
    console.log('');
    
    displayCurrentResults();
}

function displayCurrentResults() {
    if (Object.keys(accountResults).length === 0) return;
    
    Object.entries(accountResults).forEach(([accountPK, results]) => {
        if (results.length > 0) {
            console.log(chalk.yellow(`▼ Account PK${accountPK} (${results.length} operations):`));
            
            results.forEach((result, index) => {
                const statusIcon = result.success ? '✅' : '❌';
                const operationNumber = index + 1;
                
                console.log(chalk.gray(`  ${operationNumber}. [${result.timestamp}] ${statusIcon} ${result.phase}`));
                console.log(chalk.white(`     💰 Amount: ${result.amount} IOTA → ${result.target}`));
                
                if (result.success && result.digest) {
                    const shortDigest = result.digest.slice(0, 32) + '...';
                    console.log(chalk.gray(`     🔗 Digest: ${shortDigest}`));
                }
                
                console.log(chalk.gray(`     ⏰ Session Time: ${result.sessionTime}`));
                
                if (!result.success && result.error) {
                    console.log(chalk.red(`     ❌ Error: ${result.error.slice(0, 40)}...`));
                }
            });
            console.log('');
        }
    });
}

function addAccountResult(accountPK, resultData) {
    if (!accountResults[accountPK]) {
        accountResults[accountPK] = [];
    }
    
    accountResults[accountPK].push({
        ...resultData,
        timestamp: formatTimestamp(),
        sessionTime: formatSessionTime()
    });
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
        return false;
    }
}

function readLinesFromFile(filename) {
    try {
        return fs.readFileSync(filename, 'utf-8').split('\n').map(line => line.trim()).filter(line => line !== '');
    } catch (error) {
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
            throw new Error('Format private key tidak dikenali');
        }
    } catch (error) {
        throw new Error(`Format private key tidak valid: ${error.message}`);
    }
}

function generateRandomAmount(min = MIN_TRANSFER_AMOUNT, max = MAX_TRANSFER_AMOUNT) {
    const randomAmount = Math.random() * (max - min) + min;
    return parseFloat(randomAmount.toFixed(6));
}

function generateRandomValidatorStakeAmount() {
    const randomAmount = Math.random() * (MAX_STAKE_AMOUNT - MIN_STAKE_AMOUNT) + MIN_STAKE_AMOUNT;
    return parseFloat(randomAmount.toFixed(6));
}

function loadWalletsWithProxyMapping() {
    const privateKeyLines = readLinesFromFile(PK_FILE);
    const proxyLines = readLinesFromFile(PROXY_FILE);
    const validPrivateKeys = [];
    const pkLineNumbers = [];

    privateKeyLines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (trimmedLine !== '' && !trimmedLine.startsWith('#')) {
            validPrivateKeys.push(trimmedLine);
            pkLineNumbers.push(index);
        }
    });

    const walletProxyPairs = [];
    for (let i = 0; i < validPrivateKeys.length; i++) {
        const privateKeyString = validPrivateKeys[i];
        const originalLineNumber = pkLineNumbers[i];
        let proxyString = null;

        if (originalLineNumber < proxyLines.length) {
            const proxyLine = proxyLines[originalLineNumber].trim();
            if (proxyLine !== '' && !proxyLine.startsWith('#')) {
                proxyString = proxyLine;
            }
        }

        try {
            const keypair = createKeypairFromPrivateKey(privateKeyString);
            const address = keypair.getPublicKey().toIotaAddress();

            walletProxyPairs.push({
                index: i,
                originalLineNumber: originalLineNumber + 1,
                keypair,
                address,
                privateKey: privateKeyString,
                proxy: proxyString,
                proxyDisplay: proxyString ? `${proxyString.split(':')[0]}:${proxyString.split(':')[1]}` : 'LOCAL_IP'
            });
        } catch (error) {
            // Skip invalid keys silently
        }
    }

    return walletProxyPairs;
}

function getValidators() {
    let validators = readLinesFromFile(VALIDATORS_FILE).filter(line => line.trim() !== '' && !line.startsWith('#'));

    if (validators.length === 0) {
        if (selectedNetwork === 'testnet' || selectedNetwork === 'devnet') {
            validators = DEFAULT_TESTNET_VALIDATORS;
        }
    }

    return validators;
}

async function executeTransactionWithRetries(keypair, tx) {
    for (let attempt = 1; attempt <= TRANSACTION_RETRIES; attempt++) {
        try {
            const result = await iotaClient.signAndExecuteTransaction({
                signer: keypair,
                transaction: tx
            });
            return { success: true, result, attempt };
        } catch (error) {
            if (attempt < TRANSACTION_RETRIES) {
                await sleep(RETRY_DELAY_MS);
            } else {
                return { success: false, error };
            }
        }
    }
}

// ===================================================================================
// MULTI-VALIDATOR STAKING FUNCTION
// ===================================================================================
async function executeMultiValidatorStaking(wallet, validators, accountPK, globalStats) {
    updateStatus(`🔒 Starting Multi-Validator Staking - PK${accountPK} (${validators.length} validators)`);
    
    let totalStakeAmount = 0;
    let successfulStakes = 0;
    let failedStakes = 0;
    
    const stakingAmounts = validators.map(() => generateRandomValidatorStakeAmount());
    const totalRequired = stakingAmounts.reduce((sum, amount) => sum + amount, 0) + (validators.length * 0.1);
    
    try {
        const balanceResponse = await iotaClient.getBalance({ owner: wallet.address });
        const currentBalance = parseFloat(balanceResponse.totalBalance) / Number(NANOS_PER_IOTA);
        
        updateStatus(`💳 Checking balance: ${currentBalance.toFixed(6)} IOTA | Required: ${totalRequired.toFixed(6)} IOTA`);
        
        if (currentBalance < totalRequired) {
            addAccountResult(accountPK, {
                success: false,
                phase: `MULTI-STAKING - PK${accountPK} (${validators.length} validators)`,
                amount: totalRequired.toFixed(6),
                target: 'All Validators',
                error: `Insufficient balance: ${currentBalance.toFixed(6)} < ${totalRequired.toFixed(6)} IOTA`
            });
            
            globalStats.staking.failed += validators.length;
            updateStatus(`❌ Insufficient balance for multi-validator staking`);
            return;
        }
    } catch (error) {
        addAccountResult(accountPK, {
            success: false,
            phase: `MULTI-STAKING - PK${accountPK}`,
            amount: 'Unknown',
            target: 'All Validators',
            error: `Balance check failed: ${error.message}`
        });
        
        globalStats.staking.failed += validators.length;
        updateStatus(`❌ Balance check failed: ${error.message.slice(0, 50)}...`);
        return;
    }
    
    for (let validatorIndex = 0; validatorIndex < validators.length; validatorIndex++) {
        const validator = validators[validatorIndex];
        const stakeAmount = stakingAmounts[validatorIndex];
        const validatorShort = `${validator.slice(0, 8)}...${validator.slice(-8)}`;
        
        updateStatus(`🔒 Staking [${validatorIndex + 1}/${validators.length}] - ${stakeAmount} IOTA → ${validatorShort}`);

        try {
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

            const outcome = await executeTransactionWithRetries(wallet.keypair, tx);

            if (outcome.success) {
                successfulStakes++;
                totalStakeAmount += stakeAmount;
                globalStats.staking.success++;
                globalStats.staking.totalStaked += stakeAmount;
                
                addAccountResult(accountPK, {
                    success: true,
                    phase: `STAKING [${validatorIndex + 1}/${validators.length}] - PK${accountPK}`,
                    amount: stakeAmount,
                    target: `Val: ${validatorShort}`,
                    digest: outcome.result.digest
                });
                
                updateStatus(`✅ Staking Success [${validatorIndex + 1}/${validators.length}] - ${stakeAmount} IOTA`);
            } else {
                failedStakes++;
                globalStats.staking.failed++;
                
                addAccountResult(accountPK, {
                    success: false,
                    phase: `STAKING [${validatorIndex + 1}/${validators.length}] - PK${accountPK}`,
                    amount: stakeAmount,
                    target: `Val: ${validatorShort}`,
                    error: outcome.error.message
                });
                
                updateStatus(`❌ Staking Failed [${validatorIndex + 1}/${validators.length}] - ${outcome.error.message.slice(0, 40)}...`);
            }
        } catch (error) {
            failedStakes++;
            globalStats.staking.failed++;
            
            addAccountResult(accountPK, {
                success: false,
                phase: `STAKING [${validatorIndex + 1}/${validators.length}] - PK${accountPK}`,
                amount: stakeAmount,
                target: `Val: ${validatorShort}`,
                error: error.message
            });
            
            updateStatus(`❌ Staking Error [${validatorIndex + 1}/${validators.length}] - ${error.message.slice(0, 40)}...`);
        }

        if (validatorIndex < validators.length - 1) {
            const validatorDelay = Math.floor(Math.random() * 5000) + 2000;
            updateStatus(`⏱️ Validator delay ${Math.round(validatorDelay / 1000)}s before next staking...`);
            await sleep(validatorDelay);
        }
    }
    
    updateStatus(`✅ Multi-Validator Staking Complete: ${successfulStakes}/${validators.length} success | Total: ${totalStakeAmount.toFixed(6)} IOTA`);
}

// ===================================================================================
// MAIN SEQUENTIAL FLOW
// ===================================================================================
async function executeSequentialAccountFlow(wallets, validators, enableStaking = true) {
    sessionStartTime = new Date();
    accountResults = {};
    
    let globalStats = {
        transfer: { success: 0, failed: 0, totalTransferred: 0 },
        staking: { success: 0, failed: 0, totalStaked: 0 }
    };

    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
        const currentWallet = wallets[walletIndex];
        const accountPK = currentWallet.originalLineNumber;
        
        updateStatus(`🏦 Processing Account PK${accountPK} [${walletIndex + 1}/${wallets.length}] - Starting Transfers`);
        
        // TRANSFER PHASE
        for (let transferIndex = 0; transferIndex < TRANSFERS_PER_WALLET; transferIndex++) {
            updateStatus(`💸 Executing TRANSFER [${transferIndex + 1}/${TRANSFERS_PER_WALLET}] - PK${accountPK}`);
            
            const availableReceivers = wallets.filter((_, idx) => idx !== walletIndex);
            const receiverWallet = availableReceivers[Math.floor(Math.random() * availableReceivers.length)];
            const transferAmount = generateRandomAmount();
            const transferAmountNanos = BigInt(Math.floor(transferAmount * Number(NANOS_PER_IOTA)));
            const targetPK = receiverWallet.originalLineNumber;

            const transferPhase = `TRANSFER [${transferIndex + 1}/${TRANSFERS_PER_WALLET}] - PK${accountPK} → PK${targetPK}`;

            try {
                const balanceResponse = await iotaClient.getBalance({ owner: currentWallet.address });
                const totalBalanceNanos = BigInt(balanceResponse.totalBalance);
                const requiredAmountNanos = transferAmountNanos + GAS_FEE_BUFFER_NANOS;

                if (totalBalanceNanos >= requiredAmountNanos) {
                    const tx = new Transaction();
                    const [coin] = tx.splitCoins(tx.gas, [transferAmountNanos]);
                    tx.transferObjects([coin], receiverWallet.address);

                    const outcome = await executeTransactionWithRetries(currentWallet.keypair, tx);
                    
                    if (outcome.success) {
                        globalStats.transfer.success++;
                        globalStats.transfer.totalTransferred += transferAmount;
                        
                        addAccountResult(accountPK, {
                            success: true,
                            phase: transferPhase,
                            amount: transferAmount,
                            target: `PK${targetPK}`,
                            digest: outcome.result.digest
                        });
                        
                        updateStatus(`✅ SUCCESS - Transfer [${transferIndex + 1}/${TRANSFERS_PER_WALLET}] completed`);
                    } else {
                        globalStats.transfer.failed++;
                        
                        addAccountResult(accountPK, {
                            success: false,
                            phase: transferPhase,
                            amount: transferAmount,
                            target: `PK${targetPK}`,
                            error: outcome.error.message
                        });
                        
                        updateStatus(`❌ FAILED - Transfer [${transferIndex + 1}/${TRANSFERS_PER_WALLET}] failed`);
                    }
                } else {
                    globalStats.transfer.failed++;
                    
                    addAccountResult(accountPK, {
                        success: false,
                        phase: transferPhase,
                        amount: transferAmount,
                        target: `PK${targetPK}`,
                        error: 'Insufficient balance'
                    });
                    
                    updateStatus(`❌ FAILED - Insufficient balance for transfer`);
                }
            } catch (error) {
                globalStats.transfer.failed++;
                
                addAccountResult(accountPK, {
                    success: false,
                    phase: transferPhase,
                    amount: transferAmount,
                    target: `PK${targetPK}`,
                    error: error.message
                });
                
                updateStatus(`❌ ERROR - Transfer failed: ${error.message.slice(0, 50)}...`);
            }

            if (transferIndex < TRANSFERS_PER_WALLET - 1) {
                const delay = generateRandomDelay();
                updateStatus(`⏱️ Delay ${Math.round(delay / 1000)}s before next transfer...`);
                await sleep(delay);
            }
        }

        // STAKING PHASE
        if (enableStaking && validators.length > 0) {
            const phaseTransitionDelay = Math.floor(Math.random() * 3000) + 2000;
            updateStatus(`🔄 Transfer completed! Starting multi-validator staking in ${Math.round(phaseTransitionDelay / 1000)}s...`);
            await sleep(phaseTransitionDelay);
            
            await executeMultiValidatorStaking(currentWallet, validators, accountPK, globalStats);
        }

        const stakingOps = enableStaking ? validators.length : 0;
        updateStatus(`✅ Account PK${accountPK} COMPLETED (${TRANSFERS_PER_WALLET} transfers + ${stakingOps} stakings)`);
        
        if (walletIndex < wallets.length - 1) {
            const nextAccountDelay = generateRandomDelay();
            updateStatus(`🔄 Moving to next account (PK${wallets[walletIndex + 1].originalLineNumber}) in ${Math.round(nextAccountDelay / 1000)} seconds...`);
            await sleep(nextAccountDelay);
        }
    }

    return globalStats;
}

// ===================================================================================
// MAIN AUTOMATED CYCLE - WITH PROPER ASYNC HANDLING
// ===================================================================================
async function runAutomatedCycle(config) {
    const wallets = loadWalletsWithProxyMapping();
    if (wallets.length < 2) {
        return false;
    }

    const validators = getValidators();
    if (config.autoLoop.enableStaking && validators.length === 0) {
        config.autoLoop.enableStaking = false;
    }

    // Execute cycle and show final results
    const globalStats = await executeSequentialAccountFlow(wallets, validators, config.autoLoop.enableStaking);

    // Show final results for 10 seconds, then return to menu [web:131][web:134]
    process.stdout.write('\x1Bc');
    
    console.log(chalk.bold.blue('🚀 CYCLE COMPLETED'));
    console.log(chalk.cyan('═'.repeat(60)));
    console.log('');
    
    Object.entries(accountResults).forEach(([accountPK, results]) => {
        if (results.length > 0) {
            console.log(chalk.yellow(`▼ Account PK${accountPK} (${results.length} operations):`));
            
            results.forEach((result, index) => {
                const statusIcon = result.success ? '✅' : '❌';
                const operationNumber = index + 1;
                
                console.log(chalk.gray(`  ${operationNumber}. [${result.timestamp}] ${statusIcon} ${result.phase}`));
                console.log(chalk.white(`     💰 Amount: ${result.amount} IOTA → ${result.target}`));
                
                if (result.success && result.digest) {
                    const shortDigest = result.digest.slice(0, 32) + '...';
                    console.log(chalk.gray(`     🔗 Digest: ${shortDigest}`));
                }
                
                console.log(chalk.gray(`     ⏰ Session Time: ${result.sessionTime}`));
                
                if (!result.success && result.error) {
                    console.log(chalk.red(`     ❌ Error: ${result.error.slice(0, 40)}...`));
                }
            });
            console.log('');
        }
    });

    console.log(chalk.bold.green('✅ Cycle completed successfully!'));
    console.log(chalk.yellow('⏰ Returning to menu in 10 seconds...'));
    
    // Wait 10 seconds then return to menu
    await sleep(10000);

    // Update config
    config.autoLoop.lastRun = new Date().toISOString();
    saveConfig(config);

    return true;
}

// ===================================================================================
// AUTO LOOP CONTROL - FIXED ASYNC HANDLING
// ===================================================================================
function startAutoLoop() {
    const config = loadConfig();

    if (isAutoLoopRunning) {
        return false;
    }

    if (!config.autoLoop.enabled) {
        return false;
    }

    isAutoLoopRunning = true;

    // Run first cycle and handle completion properly [web:128][web:132]
    currentCyclePromise = runAutomatedCycle(config).then(() => {
        console.log(chalk.green('🔄 First cycle completed, setting up interval...'));
        return true;
    }).catch((error) => {
        console.log(chalk.red(`❌ Cycle failed: ${error.message}`));
        isAutoLoopRunning = false;
        return false;
    });

    // Set interval for subsequent cycles
    autoLoopInterval = setInterval(async () => {
        const currentConfig = loadConfig();
        if (currentConfig.autoLoop.enabled && isAutoLoopRunning) {
            try {
                await runAutomatedCycle(currentConfig);
            } catch (error) {
                console.log(chalk.red(`❌ Auto cycle error: ${error.message}`));
            }
        } else {
            stopAutoLoop();
        }
    }, config.autoLoop.intervalHours * HOURS_1_MS);

    return true;
}

function stopAutoLoop() {
    if (autoLoopInterval) {
        clearInterval(autoLoopInterval);
        autoLoopInterval = null;
    }
    isAutoLoopRunning = false;
    currentCyclePromise = null;
    return true;
}

// ===================================================================================
// NETWORK SELECTION & MAIN MENU - FIXED RESPONSIVE HANDLING
// ===================================================================================
function selectNetwork() {
    return new Promise(resolve => {
        const showPrompt = () => {
            console.log(chalk.bold.blue('🚀 IOTA WALLET MANAGER V2.5'));
            console.log(chalk.cyan('MULTI-VALIDATOR STAKING | Stake to ALL Validators'));
            console.log('');
            console.log(chalk.cyan('Available Networks:'));
            console.log(` 1. Mainnet ${chalk.red.bold('(REAL MONEY - BE VERY CAREFUL!')}`);
            console.log(` 2. Testnet ${chalk.green.bold('(SAFE FOR TESTING)')}`);
            console.log(` 3. Devnet ${chalk.blue.bold('(DEVELOPMENT NETWORK)')}`);
            console.log('');

            rl.question(chalk.yellow('Select network (1-3): '), (choice) => {
                if (choice.trim() === '1') {
                    resolve('mainnet');
                } else if (choice.trim() === '2') {
                    resolve('testnet');
                } else if (choice.trim() === '3') {
                    resolve('devnet');
                } else {
                    console.log(chalk.red('❌ Invalid choice, please try again'));
                    showPrompt();
                }
            });
        };
        showPrompt();
    });
}

// FIXED: Proper async/await handling in menu system [web:134][web:140]
async function showMenu() {
    process.stdout.write('\x1Bc'); // Clear for menu
    
    console.log(chalk.bold.blue('🚀 IOTA WALLET MANAGER V2.5'));
    console.log(chalk.cyan('MULTI-VALIDATOR STAKING | Stake to ALL Validators'));
    console.log(chalk.cyan('═'.repeat(80)));
    console.log('');
    console.log(chalk.yellow('📍 System Status:'));
    console.log(chalk.cyan(` Network: ${selectedNetwork.toUpperCase()}`));
    console.log(chalk.cyan(` Auto Loop: ${isAutoLoopRunning ? '🟢 RUNNING' : '🔴 STOPPED'}`));
    console.log(chalk.cyan(` Flow: 3 Transfer → Stake to ALL Validators`));
    console.log(chalk.cyan(` Staking: 1x per validator (${MIN_STAKE_AMOUNT}-${MAX_STAKE_AMOUNT} IOTA each)`));
    console.log(chalk.cyan(` Validators: ${getValidators().length} validators loaded`));
    console.log(chalk.cyan(` Time: ${getCurrentTimestamp()}`));
    console.log('');
    console.log(chalk.cyan('🎯 Available Options:'));
    console.log('');
    console.log(' 1. 💰 Check Balance');
    console.log(' 2. 🚰 Manual Faucet');
    console.log(' 3. ⚙️  Configure Auto Loop');
    console.log(' 4. 🔄 Start/Stop Auto Loop');
    console.log(' 5. 🌐 Change Network');
    console.log(' 6. 🚪 Exit');
    console.log('');
    console.log(chalk.cyan('─'.repeat(80)));
    console.log(chalk.gray('🎯 NEW FLOW: Account PK1 (3 transfers + stake to ALL validators)'));
    console.log(chalk.gray('📊 Multi-Staking: Each account stakes 1x to each validator (1-3 IOTA each)'));
    console.log(chalk.gray('🌐 Diversification: Distribute stake across ALL available validators'));
    console.log(chalk.cyan('─'.repeat(80)));
    console.log('');

    // Use Promise-based question to handle async properly [web:134]
    const askQuestion = (query) => {
        return new Promise(resolve => {
            rl.question(query, resolve);
        });
    };

    try {
        const choice = await askQuestion(chalk.yellow('Select option (1-6): '));
        
        switch (choice.trim()) {
            case '1':
                console.log(chalk.blue('ℹ️ Balance check feature coming soon...'));
                await sleep(2000);
                showMenu(); // Return to menu
                break;
            case '2':
                console.log(chalk.blue('ℹ️ Faucet feature coming soon...'));
                await sleep(2000);
                showMenu(); // Return to menu
                break;
            case '3':
                console.log(chalk.blue('ℹ️ Configuration feature coming soon...'));
                await sleep(2000);
                showMenu(); // Return to menu
                break;
            case '4':
                if (isAutoLoopRunning) {
                    const stopped = stopAutoLoop();
                    if (stopped) {
                        console.log(chalk.yellow('🔄 Auto loop stopped successfully'));
                    }
                } else {
                    console.log(chalk.blue('🔄 Starting auto loop...'));
                    const started = startAutoLoop();
                    if (started) {
                        console.log(chalk.green('🔄 Auto loop started - Multi-validator staking'));
                        console.log(chalk.yellow('⏰ First cycle will begin shortly...'));
                        
                        // Wait for first cycle to complete, then return to menu
                        if (currentCyclePromise) {
                            await currentCyclePromise;
                        }
                    } else {
                        console.log(chalk.red('❌ Failed to start auto loop'));
                    }
                }
                await sleep(2000);
                showMenu(); // Return to menu
                break;
            case '5':
                console.log(chalk.blue('ℹ️ Returning to network selection...'));
                await sleep(1000);
                start(); // Restart from network selection
                break;
            case '6':
                if (isAutoLoopRunning) {
                    stopAutoLoop();
                    console.log(chalk.yellow('🔄 Stopped auto loop before exit'));
                }
                console.log(chalk.blue('ℹ️ Goodbye! 👋'));
                rl.close();
                process.exit(0);
                break;
            default:
                console.log(chalk.red('❌ Invalid option!'));
                await sleep(2000);
                showMenu(); // Return to menu
                break;
        }
    } catch (error) {
        console.log(chalk.red(`❌ Menu error: ${error.message}`));
        await sleep(2000);
        showMenu(); // Return to menu
    }
}

async function start() {
    try {
        selectedNetwork = await selectNetwork();
        iotaClient = new IotaClient({ url: getFullnodeUrl(selectedNetwork) });
        
        process.stdout.write('\x1Bc'); // Clear after connection
        console.log(chalk.green(`✅ Connected to IOTA ${selectedNetwork}`));
        
        await sleep(1000);
        showMenu(); // Start menu system
    } catch (error) {
        console.log(chalk.red(`❌ Connection failed: ${error.message}`));
        await sleep(2000);
        start(); // Retry connection
    }
}

// Handle process interruption
process.on('SIGINT', () => {
    if (isAutoLoopRunning) {
        stopAutoLoop();
    }
    console.log(chalk.blue('\n👋 Goodbye!'));
    rl.close();
    process.exit(0);
});

// Start the application
start();
