import { DatabaseProvider } from '@wolfari/database';
import { Inject, Injectable } from '@nestjs/common';
import type { FundSetupContext } from '../domain/fund-setup';
import { assertCanCreateFinancialNote, FinancialNoteRuleError, planFinancialNoteMutation } from '../domain/financial-note-management';
import type { FinancialNoteAction, FinancialNotePage, FinancialNotePatch, FinancialNoteWrite } from '../inputs/financial-note.input';
import { financialNoteCursor } from '../inputs/financial-note.input';
import { FinanceReadError } from '../finance.errors';
import { financialNoteResponse, type FinancialNoteRow } from '../projections/financial-note-response';
import type { FundWrite, StoredResult } from './fund-command.repository';

export type FinancialNoteWriteCommand =
  | { scope:'CREATE_FINANCIAL_NOTE'; fundId:string; body:FinancialNoteWrite }
  | { scope:'UPDATE_FINANCIAL_NOTE'|'DELETE_FINANCIAL_NOTE'; fundId:string; noteId:string; body:FinancialNotePatch|FinancialNoteAction };
export const isFinancialNoteWrite=(input:FundWrite):input is FundWrite&FinancialNoteWriteCommand => ['CREATE_FINANCIAL_NOTE','UPDATE_FINANCIAL_NOTE','DELETE_FINANCIAL_NOTE'].includes(input.scope);
type Client=Pick<DatabaseProvider,'query'>;
const columns='id,fund_id,payer_user_id,amount::text,description,created_by_user_id,version,created_at,updated_at';

@Injectable()
export class FinancialNoteRepository {
  constructor(@Inject(DatabaseProvider) private readonly db:Pick<DatabaseProvider,'query'>) {}
  async list(page:FinancialNotePage) {
    const result=await this.db.query<{finance_version:number;items:{row:FinancialNoteRow;at:string;id:string}[]}>(
      `WITH page AS (
        SELECT id,created_at FROM financial_notes WHERE fund_id=$1 AND deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $4
      ), note_rows AS (SELECT ${columns} FROM financial_notes WHERE id IN (SELECT id FROM page))
      SELECT f.finance_version,COALESCE((SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(n),'at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',p.id) ORDER BY p.created_at DESC,p.id DESC) FROM page p JOIN note_rows n ON n.id=p.id),'[]'::jsonb) items FROM funds f WHERE f.id=$1`,
      [page.fundId,page.after?.at??null,page.after?.id??null,page.limit+1],
    );
    const row=result.rows[0]; if(!row) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const items=row.items.slice(0,page.limit),last=items.at(-1);
    return {financeVersion:row.finance_version,items:items.map(x=>x.row),nextCursor:row.items.length>page.limit&&last?financialNoteCursor(page,last):undefined};
  }
  async execute(client:Client,input:FundWrite&FinancialNoteWriteCommand,authority:FundSetupContext,correlation:string):Promise<StoredResult> {
    const fund=(await client.query<{status:string;finance_version:number}>('SELECT status,finance_version FROM funds WHERE id=$1 AND trip_id=$2 FOR UPDATE',[input.fundId,input.tripId])).rows[0];
    if(!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const context={...authority,financeVersion:fund.finance_version,fundStatus:fund.status};
    let row:FinancialNoteRow; let fromVersion:number|null=null;
    if(input.scope==='CREATE_FINANCIAL_NOTE') {
      assertCanCreateFinancialNote(input.body,context);
      row=(await client.query<FinancialNoteRow>(`INSERT INTO financial_notes(fund_id,payer_user_id,amount,description,created_by_user_id) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,[input.fundId,input.body.payerUserId,input.body.amount?.toString()??null,input.body.description,input.actor])).rows[0]!;
    } else {
      row=(await client.query<FinancialNoteRow>(`SELECT ${columns} FROM financial_notes WHERE id=$1 AND fund_id=$2 AND deleted_at IS NULL FOR UPDATE`,[input.noteId,input.fundId])).rows[0]!;
      if(!row) throw new FinanceReadError('RESOURCE_NOT_FOUND'); fromVersion=row.version;
      const plan=planFinancialNoteMutation(input.body,{createdByUserId:row.created_by_user_id,description:row.description,amount:row.amount===null?null:BigInt(row.amount),payerUserId:row.payer_user_id,version:row.version},context);
      if(!plan.changed) return {version:1,tripId:input.tripId,financialNote:financialNoteResponse(row,fund.finance_version)};
      if(row.version===2147483647) throw new FinanceReadError('STATE_CONFLICT');
      if(input.scope==='UPDATE_FINANCIAL_NOTE') {
        const patch=input.body as FinancialNotePatch;
        row=(await client.query<FinancialNoteRow>(`UPDATE financial_notes SET description=COALESCE($2,description),amount=CASE WHEN $3 THEN $4 ELSE amount END,payer_user_id=CASE WHEN $5 THEN $6 ELSE payer_user_id END,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,[row.id,patch.description??null,patch.amount!==undefined,patch.amount?.toString()??null,patch.payerUserId!==undefined,patch.payerUserId??null])).rows[0]!;
      } else row=(await client.query<FinancialNoteRow>(`UPDATE financial_notes SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,[row.id])).rows[0]!;
    }
    const financeVersion=fund.finance_version+1;
    await client.query('UPDATE funds SET finance_version=$2,updated_at=clock_timestamp() WHERE id=$1',[input.fundId,financeVersion]);
    await client.query(`INSERT INTO finance_audit_logs(fund_id,actor_user_id,action,entity_type,entity_id,from_version,to_version,correlation_id,details) VALUES($1,$2,$3,'FinancialNote',$4,$5,$6,$7,$8::jsonb)`,[input.fundId,input.actor,input.scope,row.id,fromVersion,row.version,correlation,JSON.stringify({operation_id:input.operationId,finance_version:financeVersion})]);
    return {version:1,tripId:input.tripId,financialNote:financialNoteResponse(row,financeVersion)};
  }
}
export function mapFinancialNoteRuleError(error:unknown) { return error instanceof FinancialNoteRuleError?new FinanceReadError(error.code):undefined; }
