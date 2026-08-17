import { ApplicationRuntime } from './application/runtime.js';
import { createTelegramBot, registerTelegramCommands } from './bot/telegram.js';
import { EvmChainManager } from './blockchain/clients/evm-chain-manager.js';
import { ViemExecutionClient } from './blockchain/clients/execution-client.js';
import { CopyTransactionConfirmationEngine } from './blockchain/listeners/copy-transaction-confirmation-engine.js';
import { MonitoringEngine } from './blockchain/listeners/monitoring-engine.js';
import { PendingMonitoringEngine, type PendingAnalysisHook } from './blockchain/listeners/pending-monitoring-engine.js';
import { loadChainConfigs } from './config/chains.js';
import { env } from './config/env.js';
import { createPostgresPool } from './database/postgres.js';
import { AutomaticExecutionContextRepository } from './database/repositories/automatic-execution-context-repository.js';
import { ChainRepository } from './database/repositories/chain-repository.js';
import { CopyTransactionProposalRepository } from './database/repositories/copy-transaction-proposal-repository.js';
import { DetectedMintRepository } from './database/repositories/detected-mint-repository.js';
import { DetectedTransactionRepository } from './database/repositories/detected-transaction-repository.js';
import { ExecutionAttemptRepository } from './database/repositories/execution-attempt-repository.js';
import { ExecutionRequestRepository } from './database/repositories/execution-request-repository.js';
import { MonitoredAddressRepository } from './database/repositories/monitored-address-repository.js';
import { MonitoringCheckpointRepository } from './database/repositories/monitoring-checkpoint-repository.js';
import { UserExecutionSettingsRepository } from './database/repositories/user-execution-settings-repository.js';
import { UserRepository } from './database/repositories/user-repository.js';
import { createRedisConnection } from './queue/redis.js';
import { CompositePendingAnalysisHook } from './services/composite-pending-analysis-hook.js';
import { PostgresDestinationWalletLock } from './services/destination-wallet-lock.js';
import { ExecutionSettingsService } from './services/execution-settings-service.js';
import { MonitoringService } from './services/monitoring-service.js';
import { NftMintDetector } from './services/nft-mint-detector.js';
import { PendingAutomaticExecutionService } from './services/pending-automatic-execution-service.js';
import { PendingCalldataClassifier } from './services/pending-calldata-classifier.js';
import { ProposalApprovalService } from './services/proposal-approval-service.js';
import { createConfiguredSigner } from './services/signer-factory.js';
import { AutomaticTransactionExecutor } from './services/transaction-executor.js';
import { serializeError } from './utils/errors.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger(env);
const postgres = createPostgresPool(env.DATABASE_URL);
const redis = createRedisConnection(env.REDIS_URL);
redis.on('error', (error) => logger.warn({ error }, 'Redis connection error'));

const chainManager = new EvmChainManager(loadChainConfigs(env.CHAINS_CONFIG_PATH));
const users = new UserRepository(postgres);
const monitoredAddresses = new MonitoredAddressRepository(postgres);
const chains = new ChainRepository(postgres);
const detectedTransactions = new DetectedTransactionRepository(postgres);
const executionAttempts = new ExecutionAttemptRepository(postgres);
const mintDetector = new NftMintDetector(detectedTransactions, new DetectedMintRepository(postgres), logger);
const monitoringEngine = new MonitoringEngine(chainManager, monitoredAddresses, detectedTransactions, new MonitoringCheckpointRepository(postgres), logger, mintDetector);

const hooks: PendingAnalysisHook[] = [new PendingCalldataClassifier(detectedTransactions, logger)];
const configuredSigner = createConfiguredSigner(env);
const automaticExecutionEnabled = configuredSigner.enabled;
if (configuredSigner.enabled) {
  const signer = configuredSigner.signer;
  const settings = new UserExecutionSettingsRepository(postgres);
  const proposals = new CopyTransactionProposalRepository(postgres);
  const contexts = new AutomaticExecutionContextRepository(postgres);
  const chainCache = new Map<string, number>();
  const executor = new AutomaticTransactionExecutor(proposals, settings, contexts, executionAttempts, signer, (databaseChainId) => {
    const externalChainId = chainCache.get(databaseChainId);
    if (externalChainId === undefined) throw new Error(`No configured EVM chain for database chain ${databaseChainId}`);
    return { chainId: externalChainId, client: new ViemExecutionClient(chainManager.getPublicClient(externalChainId)) };
  }, undefined, undefined, new PostgresDestinationWalletLock(postgres));
  hooks.push(new PendingAutomaticExecutionService(settings, proposals, (chain) => new ViemExecutionClient(chainManager.getPublicClient(chain.id)), executor, logger,
    (databaseChainId, externalChainId) => chainCache.set(databaseChainId, externalChainId)));
  logger.info({ signerProvider: configuredSigner.provider }, 'Automatic execution signer configured');
}

const pendingMonitoringEngine = new PendingMonitoringEngine(chainManager, monitoredAddresses, detectedTransactions, logger, undefined, new CompositePendingAnalysisHook(hooks));
const confirmationEngine = new CopyTransactionConfirmationEngine(chainManager, executionAttempts, logger);
const monitoringService = new MonitoringService(users, chains, monitoredAddresses, () => chainManager.getConfiguredChains(), async () => {
  await Promise.all([monitoringEngine.refreshNow(), pendingMonitoringEngine.refreshNow()]);
});

const telegram = env.TELEGRAM_BOT_TOKEN ? createTelegramBot(env.TELEGRAM_BOT_TOKEN) : undefined;
if (telegram) {
  const approvalService = new ProposalApprovalService(new CopyTransactionProposalRepository(postgres), new ExecutionRequestRepository(postgres), users, monitoredAddresses);
  const executionSettings = new ExecutionSettingsService(new UserExecutionSettingsRepository(postgres));
  registerTelegramCommands(telegram, monitoringService, () => chainManager.getConfiguredChains(), approvalService, {
    executionSettings,
    autoExecutionAvailable: () => automaticExecutionEnabled,
  });
}

const runtime = new ApplicationRuntime({
  postgres,
  redis,
  monitoring: monitoringEngine,
  pendingMonitoring: pendingMonitoringEngine,
  confirmation: confirmationEngine,
  telegram,
  automaticExecutionEnabled,
  automaticExecutionProvider: configuredSigner.provider,
  logger,
});

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  await runtime.shutdown(signal);
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.fatal({ error: serializeError(error) }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.fatal({ error: serializeError(error) }, 'Unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

logger.info({ environment: env.NODE_ENV, configuredChainIds: chainManager.getConfiguredChains().map(({ id }) => id) }, 'Application initialized');
void runtime.start().catch((error) => {
  logger.fatal({ error: serializeError(error) }, 'Worker startup failed');
  void shutdown('workerStartupFailure', 1);
});
