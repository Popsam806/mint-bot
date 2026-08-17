import { describe, expect, it, vi } from 'vitest';
import { callbacks, mainMenu, registerTelegramCommands, type BotContext } from '../../src/bot/telegram.js';

type Handler = (ctx: BotContext & Record<string, unknown>) => Promise<void> | void;

function harness() {
  const actions: Array<{ trigger: string | RegExp; handler: Handler }> = [];
  const commands = new Map<string, Handler>();
  const ons = new Map<string, Handler>();
  let start: Handler | undefined;
  const bot = {
    use: vi.fn(), catch: vi.fn(),
    start: vi.fn((handler: Handler) => { start = handler; }),
    help: vi.fn((handler: Handler) => commands.set('help', handler)),
    command: vi.fn((name: string, handler: Handler) => commands.set(name, handler)),
    action: vi.fn((trigger: string | RegExp, handler: Handler) => actions.push({ trigger, handler })),
    on: vi.fn((name: string, handler: Handler) => ons.set(name, handler)),
  };
  const findAction = (data: string) => {
    const item = actions.find(({ trigger }) => typeof trigger === 'string' ? trigger === data : (trigger.lastIndex = 0, trigger.test(data)));
    if (!item) throw new Error(`Missing action ${data}`);
    const match = typeof item.trigger === 'string' ? [data] : data.match(item.trigger);
    return { handler: item.handler, match };
  };
  return { bot, commands, ons, getStart: () => start, findAction };
}

function context(text = '') {
  return {
    from: { id: 42, username: 'alice' }, chat: { id: 42 }, session: {}, match: [] as unknown as RegExpExecArray,
    message: { text }, reply: vi.fn(async () => undefined), editMessageText: vi.fn(async () => undefined),
    editMessageReplyMarkup: vi.fn(async () => undefined), answerCbQuery: vi.fn(async () => undefined),
  } as unknown as BotContext & Record<string, unknown>;
}

function setup(autoAvailable = false) {
  const h = harness();
  const wallets: Array<{ id: string; walletAddress: string; chainName: string; enabled: boolean }> = [];
  const service = {
    ensureUser: vi.fn(async () => ({ id: 'user-1' })), validateWalletAddress: vi.fn((address: string) => { if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('invalid'); }),
    watch: vi.fn(async (_user: string, address: string, chain: string) => { wallets.push({ id: 'wallet-1', walletAddress: address, chainName: chain === '1' ? 'Ethereum' : chain, enabled: true }); }),
    status: vi.fn(async () => wallets), stop: vi.fn(async () => true),
    start: vi.fn(async (_user: string, id: string) => { const wallet = wallets.find((item) => item.id === id); if (!wallet) return false; wallet.enabled = true; return true; }),
    remove: vi.fn(async (_user: string, id: string) => { const wallet = wallets.find((item) => item.id === id); if (!wallet) return false; wallet.enabled = false; return true; }),
    configuredChainStatus: vi.fn(async () => [{ id: 1, name: 'Ethereum', enabled: true }]),
  };
  const settings = {
    get: vi.fn(async () => ({ executionMode: 'DISABLED', destinationWallet: null, allowedChains: [], allowedContracts: [], maxNativeValue: null, maxGas: null, maxQuantity: null })),
    update: vi.fn(async () => undefined),
  };
  registerTelegramCommands(h.bot as never, service as never, () => [{ id: 1, name: 'Ethereum' }], undefined, { executionSettings: settings as never, autoExecutionAvailable: () => autoAvailable });
  return { ...h, service, settings, wallets };
}

describe('Telegram inline UX', () => {
  it('builds the complete main menu', () => {
    const labels = mainMenu().reply_markup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toEqual(['👀 Watch Wallet', 'Manage Wallets', '⛓ Chains', '⚡ Execution', '📊 Status', '🧾 Activity', '⚙️ Settings']);
  });

  it('/start registers the user and displays the dashboard', async () => {
    const test = setup(); const ctx = context(); await test.getStart()?.(ctx);
    expect(test.service.ensureUser).toHaveBeenCalledWith('42', 'alice');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('EVM Copy Mint Bot'), expect.objectContaining({ reply_markup: expect.anything() }));
  });

  it('navigates into Watch Wallet and selects a chain', async () => {
    const test = setup(); const ctx = context();
    await test.findAction(callbacks.watch).handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Choose a chain'), expect.anything());
    const selected = test.findAction('watch:chain:1'); ctx.match = selected.match; await selected.handler(ctx);
    expect(ctx.session).toEqual({ step: 'watch_address', selectedChainId: '1' });
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Never send a private key or seed phrase'), expect.anything());
  });

  it('validates and registers the wallet selected through the button flow', async () => {
    const test = setup(); const address = '0x0000000000000000000000000000000000000010'; const ctx = context(address);
    ctx.session = { step: 'watch_address', selectedChainId: '1' };
    await test.ons.get('text')?.(ctx);
    expect(test.service.validateWalletAddress).toHaveBeenCalledWith(address);
    expect(test.service.watch).toHaveBeenCalledWith('user-1', address, '1');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Wallet registered'), expect.anything());
  });

  it('keeps the watch flow active after invalid input', async () => {
    const test = setup(); const ctx = context('not-a-wallet'); ctx.session = { step: 'watch_address', selectedChainId: '1' };
    await test.ons.get('text')?.(ctx);
    expect(test.service.watch).not.toHaveBeenCalled();
    expect(ctx.session.step).toBe('watch_address');
  });

  it('lists wallets with chain, shortened address, status, and remove controls', async () => {
    const test = setup(); test.wallets.push({ id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: true });
    const ctx = context(); await test.findAction(callbacks.wallets).handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Ethereum\n0x0000…0010 · Enabled'), expect.anything());
    expect(JSON.stringify(ctx.editMessageText.mock.calls[0]?.[1])).toContain('wallet:remove:wallet-1');
  });

  it('shows remove confirmation and supports cancellation', async () => {
    const test = setup(); test.wallets.push({ id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: true });
    const ctx = context(); const remove = test.findAction('wallet:remove:wallet-1'); ctx.match = remove.match; await remove.handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith('Are you sure you want to remove this wallet from monitoring?', expect.anything());
    const cancel = test.findAction(callbacks.wallets); await cancel.handler(ctx);
    expect(test.service.remove).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Manage Wallets'), expect.anything());
  });

  it('removes a wallet and updates the dashboard immediately', async () => {
    const test = setup(); test.wallets.push({ id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: true });
    const ctx = context(); const confirm = test.findAction('wallet:remove:confirm:wallet-1'); ctx.match = confirm.match; await confirm.handler(ctx);
    expect(test.service.remove).toHaveBeenCalledWith('user-1', 'wallet-1');
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Wallet removed from monitoring.'), expect.anything());
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Disabled'), expect.anything());
  });

  it('excludes disabled wallets from the active status count', async () => {
    const test = setup(); test.wallets.push(
      { id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: true },
      { id: 'wallet-2', walletAddress: '0x0000000000000000000000000000000000000020', chainName: 'Ethereum', enabled: false },
    );
    const ctx = context(); await test.findAction(callbacks.status).handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Monitored wallets: 1'), expect.anything());
  });

  it('reports zero monitored wallets when every wallet is disabled', async () => {
    const test = setup(); test.wallets.push({ id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: false });
    const ctx = context(); await test.findAction(callbacks.status).handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Monitored wallets: 0'), expect.anything());
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Monitoring: Inactive'), expect.anything());
  });

  it('shows disabled wallets separately and can re-enable them', async () => {
    const test = setup(); test.wallets.push({ id: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000010', chainName: 'Ethereum', enabled: false });
    const ctx = context(); await test.findAction(callbacks.wallets).handler(ctx);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Active (0)'), expect.anything());
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Disabled/Removed (1)'), expect.anything());
    const start = test.findAction('wallet:start:wallet-1'); ctx.match = start.match; await start.handler(ctx);
    expect(test.service.start).toHaveBeenCalledWith('user-1', 'wallet-1');
    expect(ctx.editMessageText).toHaveBeenLastCalledWith(expect.stringContaining('Active (1)'), expect.anything());
  });

  it('supports cancel and back navigation to the main menu', async () => {
    const test = setup();
    for (const callback of [callbacks.cancel, callbacks.main]) { const ctx = context(); ctx.session = { step: 'watch_address', selectedChainId: '1' }; await test.findAction(callback).handler(ctx); expect(ctx.session).toEqual({}); expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('EVM Copy Mint Bot'), expect.anything()); }
  });

  it('protects AUTO when no signer is available', async () => {
    const test = setup(false); const ctx = context(); const action = test.findAction('execution:set:AUTO'); ctx.match = action.match; await action.handler(ctx);
    expect(test.settings.update).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('AUTO is unavailable until a production signer is configured'), expect.anything());
  });

  it('keeps compatibility commands registered', () => {
    const test = setup(); expect([...test.commands.keys()]).toEqual(expect.arrayContaining(['help', 'watch', 'status', 'stop']));
  });
});
