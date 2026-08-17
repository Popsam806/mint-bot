import { Markup, Telegraf, session, type Context } from 'telegraf';
import type { ExecutionMode, UserExecutionSettings } from '../database/types.js';
import type { MonitoringService } from '../services/monitoring-service.js';
import { DisabledChainError, DuplicateMonitoringError, InvalidWalletAddressError, UnknownChainError } from '../services/monitoring-service.js';
import type { ProposalApprovalService } from '../services/proposal-approval-service.js';
import { ProposalAlreadyProcessedError, ProposalExpiredError, ProposalNotFoundError, ProposalNotReadyError, ProposalUnauthorizedError } from '../services/proposal-approval-service.js';

interface WatchSession { step?: 'watch_address'; selectedChainId?: string; }
export type BotContext = Context & { session: WatchSession };
type ChainSummary = { id: number; name: string };
type ExecutionSettingsPort = { get(userId: string): Promise<UserExecutionSettings>; update(userId: string, input: Partial<UserExecutionSettings>): Promise<UserExecutionSettings> };
export interface TelegramUxOptions { executionSettings?: ExecutionSettingsPort; autoExecutionAvailable?: () => boolean; }

export const callbacks = {
  main: 'nav:main', watch: 'nav:watch', wallets: 'nav:wallets', chains: 'nav:chains', execution: 'nav:execution',
  status: 'nav:status', activity: 'nav:activity', settings: 'nav:settings', cancel: 'nav:cancel',
};

export function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👀 Watch Wallet', callbacks.watch), Markup.button.callback('Manage Wallets', callbacks.wallets)],
    [Markup.button.callback('⛓ Chains', callbacks.chains), Markup.button.callback('⚡ Execution', callbacks.execution)],
    [Markup.button.callback('📊 Status', callbacks.status), Markup.button.callback('🧾 Activity', callbacks.activity)],
    [Markup.button.callback('⚙️ Settings', callbacks.settings)],
  ]);
}

const backMain = () => Markup.inlineKeyboard([[Markup.button.callback('← Back', callbacks.main)], [Markup.button.callback('🏠 Main Menu', callbacks.main)]]);
const cancelMenu = () => Markup.inlineKeyboard([[Markup.button.callback('Cancel', callbacks.cancel)], [Markup.button.callback('🏠 Main Menu', callbacks.main)]]);
const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const dashboardText = 'EVM Copy Mint Bot\n\nMonitor public EVM wallets and manage copy-mint preferences. This bot will never ask for a private key or seed phrase.';

function errorMessage(error: unknown): string {
  if (error instanceof InvalidWalletAddressError) return 'That is not a valid EVM wallet address. Send a public address beginning with 0x.';
  if (error instanceof UnknownChainError) return 'That chain is not available in the configured EVM chain registry.';
  if (error instanceof DisabledChainError) return 'That chain is currently disabled for monitoring.';
  if (error instanceof DuplicateMonitoringError) return 'That wallet is already being monitored for this chain.';
  if (error instanceof ProposalUnauthorizedError) return 'You are not authorized to approve this proposal.';
  if (error instanceof ProposalExpiredError) return 'This proposal has expired and must be re-analyzed.';
  if (error instanceof ProposalAlreadyProcessedError) return 'This proposal has already been processed.';
  if (error instanceof ProposalNotFoundError) return 'This proposal no longer exists.';
  if (error instanceof ProposalNotReadyError) return 'This proposal is no longer ready for approval.';
  return 'Something went wrong while processing your request. Please try again later.';
}

async function editOrReply(ctx: BotContext, text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>): Promise<void> {
  try { await ctx.editMessageText(text, keyboard); }
  catch { await ctx.reply(text, keyboard); }
}

async function userFor(ctx: BotContext, service: MonitoringService) {
  return service.ensureUser(String(ctx.from?.id ?? ''), ctx.from?.username ?? null);
}

export function createTelegramBot(token: string): Telegraf<BotContext> { return new Telegraf<BotContext>(token); }

export function registerTelegramCommands(bot: Telegraf<BotContext>, service: MonitoringService, configuredChains: () => readonly ChainSummary[], approvals?: ProposalApprovalService, options: TelegramUxOptions = {}): void {
  bot.use(session());
  const showMain = async (ctx: BotContext, edit = true) => {
    ctx.session = {};
    await userFor(ctx, service);
    if (edit) await editOrReply(ctx, dashboardText, mainMenu()); else await ctx.reply(dashboardText, mainMenu());
  };
  const showWallets = async (ctx: BotContext, notice?: string) => {
    const user = await userFor(ctx, service); const entries = await service.status(user.id);
    const active = entries.filter((entry) => entry.enabled); const disabled = entries.filter((entry) => !entry.enabled);
    const sections = [
      `Active (${active.length})\n${active.length ? active.map((entry) => `${entry.chainName}\n${shortAddress(entry.walletAddress)} · Enabled`).join('\n\n') : 'None'}`,
      `Disabled/Removed (${disabled.length})\n${disabled.length ? disabled.map((entry) => `${entry.chainName}\n${shortAddress(entry.walletAddress)} · Disabled`).join('\n\n') : 'None'}`,
    ];
    const text = `Manage Wallets${notice ? `\n\n${notice}` : ''}\n\n${sections.join('\n\n')}`;
    const rows = active.map((entry) => [Markup.button.callback(`Remove · ${shortAddress(entry.walletAddress)}`, `wallet:remove:${entry.id}`)]);
    rows.push(...disabled.map((entry) => [Markup.button.callback(`Re-enable · ${shortAddress(entry.walletAddress)}`, `wallet:start:${entry.id}`)]));
    rows.push([Markup.button.callback('← Back', callbacks.main)]); rows.push([Markup.button.callback('🏠 Main Menu', callbacks.main)]);
    await editOrReply(ctx, text, Markup.inlineKeyboard(rows));
  };
  const showExecution = async (ctx: BotContext, notice?: string) => {
    const user = await userFor(ctx, service); const settings = await options.executionSettings?.get(user.id);
    const mode = settings?.executionMode ?? 'DISABLED';
    await editOrReply(ctx, `Execution\n\nCurrent mode: ${mode}${notice ? `\n\n${notice}` : ''}`, Markup.inlineKeyboard([
      [Markup.button.callback(`${mode === 'DISABLED' ? '✓ ' : ''}DISABLED`, 'execution:set:DISABLED')],
      [Markup.button.callback(`${mode === 'TELEGRAM_APPROVAL' ? '✓ ' : ''}TELEGRAM_APPROVAL`, 'execution:set:TELEGRAM_APPROVAL')],
      [Markup.button.callback(`${mode === 'AUTO' ? '✓ ' : ''}AUTO`, 'execution:set:AUTO')],
      [Markup.button.callback('← Back', callbacks.main)], [Markup.button.callback('🏠 Main Menu', callbacks.main)],
    ]));
  };

  bot.start(async (ctx) => { try { await showMain(ctx, false); } catch { await ctx.reply(errorMessage(null)); } });
  bot.help((ctx) => ctx.reply('/start - open the main menu\n/watch - add a public EVM wallet\n/status - show monitored wallets\n/stop <id> - disable a monitored wallet\n/help - show this help', mainMenu()));
  bot.command('watch', async (ctx) => {
    ctx.session = {};
    const chains = configuredChains();
    await ctx.reply('Choose the chain to monitor:', Markup.inlineKeyboard([...chains.map((chain) => [Markup.button.callback(chain.name, `watch:chain:${chain.id}`)]), [Markup.button.callback('Cancel', callbacks.cancel)]]));
  });
  bot.command('status', async (ctx) => {
    try { const user = await userFor(ctx, service); const entries = await service.status(user.id); await ctx.reply(entries.length ? entries.map((entry) => `${entry.id}. ${entry.chainName} | ${entry.walletAddress} | ${entry.enabled ? 'enabled' : 'disabled'}`).join('\n') : 'You have no monitored wallets. Use /watch to add one.', mainMenu()); }
    catch (error) { await ctx.reply(errorMessage(error)); }
  });
  bot.command('stop', async (ctx) => {
    const id = ctx.message.text.trim().split(/\s+/)[1]; if (!id) return void ctx.reply('Use /stop followed by the wallet ID shown by /status.');
    try { const user = await userFor(ctx, service); await ctx.reply(await service.stop(user.id, id) ? 'Monitoring disabled.' : 'That monitored wallet was not found.', mainMenu()); }
    catch (error) { await ctx.reply(errorMessage(error)); }
  });

  bot.action(callbacks.main, async (ctx) => { await ctx.answerCbQuery(); try { await showMain(ctx); } catch { await ctx.reply(errorMessage(null)); } });
  bot.action(callbacks.cancel, async (ctx) => { await ctx.answerCbQuery('Cancelled'); try { await showMain(ctx); } catch { await ctx.reply(errorMessage(null)); } });
  bot.action(callbacks.watch, async (ctx) => { await ctx.answerCbQuery(); ctx.session = {}; const chains = configuredChains(); await editOrReply(ctx, 'Watch Wallet\n\nChoose a chain:', Markup.inlineKeyboard([...chains.map((chain) => [Markup.button.callback(chain.name, `watch:chain:${chain.id}`)]), [Markup.button.callback('Cancel', callbacks.cancel)], [Markup.button.callback('← Back', callbacks.main)]])); });
  bot.action(/^watch:chain:(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); const chain = configuredChains().find((item) => String(item.id) === ctx.match[1]); if (!chain) return void editOrReply(ctx, 'That chain is no longer available.', backMain()); ctx.session = { step: 'watch_address', selectedChainId: String(chain.id) }; await editOrReply(ctx, `Watch ${chain.name}\n\nSend the public EVM wallet address to monitor.\n\nNever send a private key or seed phrase.`, cancelMenu()); });
  bot.action(callbacks.wallets, async (ctx) => { await ctx.answerCbQuery(); try { await showWallets(ctx); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(/^wallet:remove:confirm:(.+)$/, async (ctx) => { await ctx.answerCbQuery(); try { const user = await userFor(ctx, service); const changed = await service.remove(user.id, ctx.match[1]!); await showWallets(ctx, changed ? 'Wallet removed from monitoring.' : 'Wallet not found.'); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(/^wallet:remove:(.+)$/, async (ctx) => { await ctx.answerCbQuery(); await editOrReply(ctx, 'Are you sure you want to remove this wallet from monitoring?', Markup.inlineKeyboard([[Markup.button.callback('Confirm Remove', `wallet:remove:confirm:${ctx.match[1]}`)], [Markup.button.callback('Cancel', callbacks.wallets)]])); });
  bot.action(/^wallet:start:(.+)$/, async (ctx) => { await ctx.answerCbQuery(); try { const user = await userFor(ctx, service); const changed = await service.start(user.id, ctx.match[1]!); await showWallets(ctx, changed ? 'Wallet re-enabled for monitoring.' : 'Wallet not found.'); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(callbacks.chains, async (ctx) => { await ctx.answerCbQuery(); try { const chains = await service.configuredChainStatus(); await editOrReply(ctx, `Chains\n\n${chains.length ? chains.map((chain) => `${chain.enabled ? '✅' : '⛔'} ${chain.name} (${chain.id})`).join('\n') : 'No chains configured.'}`, backMain()); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(callbacks.execution, async (ctx) => { await ctx.answerCbQuery(); try { await showExecution(ctx); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(/^execution:set:(DISABLED|TELEGRAM_APPROVAL|AUTO)$/, async (ctx) => {
    await ctx.answerCbQuery(); try {
      const mode = ctx.match[1] as ExecutionMode; const user = await userFor(ctx, service); const settings = await options.executionSettings?.get(user.id);
      if (!options.executionSettings) { await showExecution(ctx, 'Execution settings are unavailable.'); return; }
      if (mode === 'AUTO' && !options.autoExecutionAvailable?.()) { await showExecution(ctx, 'AUTO is unavailable until a production signer is configured.'); return; }
      if (mode === 'AUTO' && !settings?.destinationWallet) { await showExecution(ctx, 'AUTO requires a configured destination wallet.'); return; }
      await options.executionSettings.update(user.id, { executionMode: mode, ...(mode === 'AUTO' ? { destinationWallet: settings?.destinationWallet } : {}) }); await showExecution(ctx, `Execution mode changed to ${mode}.`);
    } catch (error) { await ctx.reply(errorMessage(error)); }
  });
  bot.action(callbacks.status, async (ctx) => { await ctx.answerCbQuery(); try { const user = await userFor(ctx, service); const [wallets, chains, settings] = await Promise.all([service.status(user.id), service.configuredChainStatus(), options.executionSettings?.get(user.id)]); const activeWallets = wallets.filter((wallet) => wallet.enabled); await editOrReply(ctx, `Status\n\nBot status: Online\nMonitored wallets: ${activeWallets.length}\nConfigured chains: ${chains.length}\nExecution mode: ${settings?.executionMode ?? 'DISABLED'}\nDestination wallet: ${settings?.destinationWallet ? shortAddress(settings.destinationWallet) : 'Not configured'}\nMonitoring: ${activeWallets.length ? 'Active' : 'Inactive'}`, backMain()); } catch (error) { await ctx.reply(errorMessage(error)); } });
  bot.action(callbacks.activity, async (ctx) => { await ctx.answerCbQuery(); await editOrReply(ctx, 'Activity\n\nNo recent activity.', backMain()); });
  bot.action(callbacks.settings, async (ctx) => { await ctx.answerCbQuery(); try { const user = await userFor(ctx, service); const value = await options.executionSettings?.get(user.id); await editOrReply(ctx, `Settings\n\nDestination wallet: ${value?.destinationWallet ? shortAddress(value.destinationWallet) : 'Not configured'}\nMax native cost: ${value?.maxNativeValue ?? 'Not configured'}\nMax gas cost: ${value?.maxGas ?? 'Not configured'}\nMax quantity: ${value?.maxQuantity ?? 'Not configured'}\nContract allowlist: ${value?.allowedContracts.length ? `${value.allowedContracts.length} configured` : 'Not configured'}\nChain allowlist: ${value?.allowedChains.length ? `${value.allowedChains.length} configured` : 'Not configured'}`, backMain()); } catch (error) { await ctx.reply(errorMessage(error)); } });

  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return void ctx.reply('Unknown command. Use /help or the menu below.', mainMenu());
    if (ctx.session?.step !== 'watch_address' || !ctx.session.selectedChainId) return void ctx.reply('Use the menu to choose an action.', mainMenu());
    const address = ctx.message.text.trim();
    try { service.validateWalletAddress(address); } catch (error) { return void ctx.reply(errorMessage(error), cancelMenu()); }
    try { const user = await userFor(ctx, service); await service.watch(user.id, address, ctx.session.selectedChainId); ctx.session = {}; await ctx.reply(`Wallet registered.\n\n${shortAddress(address)} is now monitored.`, Markup.inlineKeyboard([[Markup.button.callback('View Wallets', callbacks.wallets), Markup.button.callback('Add Another', callbacks.watch)], [Markup.button.callback('🏠 Main Menu', callbacks.main)]])); }
    catch (error) { ctx.session = {}; await ctx.reply(errorMessage(error), mainMenu()); }
  });
  if (approvals) {
    bot.action(/^proposal_execute:(.+)$/, async (ctx) => { try { await approvals.approve(String(ctx.from.id), ctx.match[1]!); await ctx.answerCbQuery('Approved. No transaction was broadcast.'); await ctx.editMessageReplyMarkup(undefined); await ctx.reply('Execution request created. Transaction broadcasting is not configured in this phase.'); } catch (error) { await ctx.answerCbQuery('Approval failed'); await ctx.reply(errorMessage(error)); } });
    bot.action(/^proposal_skip:(.+)$/, async (ctx) => { try { await approvals.reject(String(ctx.from.id), ctx.match[1]!); await ctx.answerCbQuery('Skipped'); await ctx.editMessageReplyMarkup(undefined); await ctx.reply('Copy proposal skipped.'); } catch (error) { await ctx.answerCbQuery('Skip failed'); await ctx.reply(errorMessage(error)); } });
  }
  bot.on('callback_query', async (ctx) => { await ctx.answerCbQuery('This menu is no longer available.'); });
  bot.catch((_error, ctx) => void ctx.reply('Telegram request failed. Please try again later.'));
}
