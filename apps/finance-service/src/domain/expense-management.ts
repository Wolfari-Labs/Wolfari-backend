import type { FundSetupContext } from './fund-setup';
import type {
  ExpenseAction,
  ExpenseConfirm,
  ExpensePatch,
  ExpenseReasonAction,
  ExpenseStatus,
  ExpenseWrite,
} from '../inputs/expense.input';

export type ExpenseScope =
  | 'CREATE_EXPENSE'
  | 'UPDATE_EXPENSE'
  | 'DELETE_EXPENSE'
  | 'SUBMIT_EXPENSE'
  | 'WITHDRAW_EXPENSE'
  | 'CONFIRM_EXPENSE'
  | 'REJECT_EXPENSE'
  | 'REVERSE_EXPENSE';
type ExpenseDraftMutationScope =
  'UPDATE_EXPENSE' | 'DELETE_EXPENSE' | 'SUBMIT_EXPENSE' | 'WITHDRAW_EXPENSE';
export type ExpenseState = {
  id: string;
  createdByUserId: string;
  status: ExpenseStatus;
  version: number;
  title: string;
  description: string | null;
  amount: bigint;
  category: string | null;
  receiptObjectKey: string | null;
  paidAt: Date | null;
  paymentMethod: string | null;
};
export class ExpenseRuleError extends Error {
  constructor(public readonly code: 'PERMISSION_DENIED' | 'STATE_CONFLICT' | 'VERSION_CONFLICT') {
    super(code);
  }
}
function base(expectedFinanceVersion: number, financeVersion: number, fundStatus: string) {
  if (expectedFinanceVersion !== financeVersion) throw new ExpenseRuleError('VERSION_CONFLICT');
  if (fundStatus !== 'OPEN') throw new ExpenseRuleError('STATE_CONFLICT');
  if (financeVersion === 2147483647) throw new ExpenseRuleError('STATE_CONFLICT');
}
function actor(scope: ExpenseDraftMutationScope, state: ExpenseState, authority: FundSetupContext) {
  const creator = authority.actorUserId === state.createdByUserId;
  const owner = authority.actorUserId === authority.ownerUserId;
  if (scope === 'WITHDRAW_EXPENSE' ? !creator : !creator && !owner)
    throw new ExpenseRuleError('PERMISSION_DENIED');
}
type ExpenseContext = {
  financeVersion: number;
  fundStatus: string;
  holderUserId: string;
} & FundSetupContext;
export function assertCanCreateExpense(
  body: ExpenseWrite,
  context: { financeVersion: number; fundStatus: string } & FundSetupContext,
) {
  base(body.expectedFinanceVersion, context.financeVersion, context.fundStatus);
  if (!context.activeMemberUserIds.has(context.actorUserId))
    throw new ExpenseRuleError('PERMISSION_DENIED');
}
export function planExpenseMutation(
  scope: ExpenseDraftMutationScope,
  body: ExpensePatch | ExpenseAction,
  state: ExpenseState,
  context: { financeVersion: number; fundStatus: string } & FundSetupContext,
) {
  base(body.expectedFinanceVersion, context.financeVersion, context.fundStatus);
  if (body.expectedVersion !== state.version) throw new ExpenseRuleError('VERSION_CONFLICT');
  actor(scope, state, context);
  if (scope === 'WITHDRAW_EXPENSE') {
    if (state.status !== 'SUBMITTED') throw new ExpenseRuleError('STATE_CONFLICT');
    return { changed: true, status: 'DRAFT' as const };
  }
  if (state.status !== 'DRAFT') throw new ExpenseRuleError('STATE_CONFLICT');
  if (scope === 'DELETE_EXPENSE') return { changed: true, status: 'DRAFT' as const };
  if (scope === 'SUBMIT_EXPENSE') return { changed: true, status: 'SUBMITTED' as const };
  const patch = body as ExpensePatch;
  const changed =
    (patch.title !== undefined && patch.title !== state.title) ||
    (patch.description !== undefined && patch.description !== state.description) ||
    (patch.amount !== undefined && patch.amount !== state.amount) ||
    (patch.category !== undefined && patch.category !== state.category) ||
    (patch.receiptObjectKey !== undefined && patch.receiptObjectKey !== state.receiptObjectKey) ||
    (patch.paidAt !== undefined && patch.paidAt?.getTime() !== state.paidAt?.getTime()) ||
    (patch.paymentMethod !== undefined && patch.paymentMethod !== state.paymentMethod);
  return { changed, status: 'DRAFT' as const };
}

export function planExpenseSettlement(
  scope: 'CONFIRM_EXPENSE' | 'REJECT_EXPENSE' | 'REVERSE_EXPENSE',
  body: ExpenseConfirm | ExpenseReasonAction,
  state: ExpenseState,
  context: ExpenseContext,
) {
  base(body.expectedFinanceVersion, context.financeVersion, context.fundStatus);
  if (body.expectedVersion !== state.version) throw new ExpenseRuleError('VERSION_CONFLICT');
  if (
    context.actorUserId !== context.holderUserId ||
    !context.activeMemberUserIds.has(context.actorUserId)
  )
    throw new ExpenseRuleError('PERMISSION_DENIED');
  if (scope === 'REVERSE_EXPENSE') {
    if (state.status !== 'CONFIRMED') throw new ExpenseRuleError('STATE_CONFLICT');
    return { status: 'REVERSED' as const };
  }
  if (state.status !== 'SUBMITTED') throw new ExpenseRuleError('STATE_CONFLICT');
  return { status: scope === 'CONFIRM_EXPENSE' ? ('CONFIRMED' as const) : ('REJECTED' as const) };
}
