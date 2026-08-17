import { Markup, type Telegraf } from 'telegraf';
import type { BotContext } from './telegram.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';

export class ProposalNotifier {
  constructor(private readonly bot: Telegraf<BotContext>, private readonly proposals: CopyTransactionProposalRepository) {}
  async notifyReady(proposalId: string): Promise<void> {
    const details = await this.proposals.getNotificationDetails(proposalId);
    if (!details || details.execution_status !== 'READY') return;
    const nativeValue = String(details.native_value ?? '0');
    const message = [`Copy mint proposal ready`, `Collection: ${details.nft_contract_address}`, `Chain: ${details.chain_name}`, `Source transaction: ${details.source_transaction_hash}`, `Destination: ${details.destination_wallet}`, `Mint quantity: ${details.quantity}`, `Native cost: ${nativeValue} base units`, `Estimated gas: ${details.gas_limit ?? 'unavailable'}`, `Total estimated cost: ${nativeValue} base units + current network fee`, `Strategy: ${details.strategy}`, `Simulation: ${details.simulation_status}`].join('\n');
    await this.bot.telegram.sendMessage(String(details.telegram_user_id), message, Markup.inlineKeyboard([Markup.button.callback('Execute', `proposal_execute:${proposalId}`), Markup.button.callback('Skip', `proposal_skip:${proposalId}`)]));
  }
}
