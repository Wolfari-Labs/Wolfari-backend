import type { FundSetupContext } from './fund-setup';
import type { FinancialNoteAction, FinancialNotePatch, FinancialNoteWrite } from '../inputs/financial-note.input';

export type FinancialNoteState = {
  createdByUserId: string;
  description: string;
  amount: bigint | null;
  payerUserId: string | null;
  version: number;
};
export class FinancialNoteRuleError extends Error {
  constructor(public readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT') { super(code); }
}
type Context = FundSetupContext & { financeVersion: number; fundStatus: string };
function base(expected: number, context: Context) {
  if (expected !== context.financeVersion) throw new FinancialNoteRuleError('VERSION_CONFLICT');
  if (context.fundStatus !== 'OPEN' || context.financeVersion === 2147483647) throw new FinancialNoteRuleError('STATE_CONFLICT');
  if (!context.activeMemberUserIds.has(context.actorUserId)) throw new FinancialNoteRuleError('PERMISSION_DENIED');
}
function validPayer(payer: string | null | undefined, context: Context) {
  if (payer !== undefined && payer !== null && !context.activeMemberUserIds.has(payer))
    throw new FinancialNoteRuleError('STATE_CONFLICT');
}
export function assertCanCreateFinancialNote(body: FinancialNoteWrite, context: Context) {
  base(body.expectedFinanceVersion, context);
  validPayer(body.payerUserId, context);
}
export function planFinancialNoteMutation(body: FinancialNotePatch | FinancialNoteAction, state: FinancialNoteState, context: Context) {
  base(body.expectedFinanceVersion, context);
  if (body.expectedVersion !== state.version) throw new FinancialNoteRuleError('VERSION_CONFLICT');
  if (context.actorUserId !== state.createdByUserId && context.actorUserId !== context.ownerUserId)
    throw new FinancialNoteRuleError('PERMISSION_DENIED');
  if (!('description' in body || 'amount' in body || 'payerUserId' in body)) return { changed: true };
  const patch = body as FinancialNotePatch;
  validPayer(patch.payerUserId, context);
  return { changed: (patch.description !== undefined && patch.description !== state.description) || (patch.amount !== undefined && patch.amount !== state.amount) || (patch.payerUserId !== undefined && patch.payerUserId !== state.payerUserId) };
}
