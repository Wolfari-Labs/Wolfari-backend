import {
  contributionInstant,
  ContributionRequestInputError,
} from './create-contribution-request.input';
import { parsePositiveVndAmount } from '../domain/money';

export type ContributionManagementScope =
  | 'UPDATE_CONTRIBUTION_REQUEST'
  | 'UPDATE_CONTRIBUTION_AMOUNT'
  | 'WAIVE_CONTRIBUTION'
  | 'CANCEL_CONTRIBUTION';
export type ContributionManagementCommand = {
  expectedVersion: number;
  expectedFinanceVersion: number;
  title?: string;
  dueAt?: Date;
  note?: string;
  amount?: bigint;
  reason?: string;
};
const invalid = (field: string): never => {
  throw new ContributionRequestInputError(field);
};
export function parseContributionManagementInput(
  scope: ContributionManagementScope,
  input: unknown,
): ContributionManagementCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('body');
  const body = input as Record<string, unknown>;
  const fields =
    scope === 'UPDATE_CONTRIBUTION_REQUEST'
      ? ['title', 'due_at', 'note']
      : scope === 'UPDATE_CONTRIBUTION_AMOUNT'
        ? ['amount']
        : ['reason'];
  if (
    Object.keys(body).some(
      (key) => ![...fields, 'expected_version', 'expected_finance_version'].includes(key),
    )
  )
    return invalid('body');
  const version = (key: string) => {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647)
      return invalid(key);
    return value;
  };
  const result: ContributionManagementCommand = {
    expectedVersion: version('expected_version'),
    expectedFinanceVersion: version('expected_finance_version'),
  };
  const present = fields.filter((key) => Object.hasOwn(body, key));
  if (!present.length) return invalid('body');
  for (const key of present) {
    const value = body[key];
    if (key === 'due_at') result.dueAt = contributionInstant(value);
    else if (key === 'amount') {
      try {
        result.amount = parsePositiveVndAmount(value);
      } catch {
        return invalid(key);
      }
    } else {
      if (
        typeof value !== 'string' ||
        value.includes('\0') ||
        (key !== 'note' && !value.trim()) ||
        (key === 'title' && [...value].length > 200)
      )
        return invalid(key);
      result[key as 'title' | 'note' | 'reason'] = value;
    }
  }
  return result;
}
