import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { FinanceV1 } from '@wolfari/contracts/grpc';
import { FinanceReadError, readUuid } from '../finance.errors';
import { parseCreateFinancialNote, parseFinancialNoteAction, parseFinancialNotePage, parseUpdateFinancialNote } from '../inputs/financial-note.input';
import { financialNoteResponse } from '../projections/financial-note-response';
import { FinancialNoteRepository, type FinancialNoteWriteCommand } from '../repositories/financial-note.repository';
import { FundCommandService } from './fund-command.service';
import { FundQueryService } from './fund-query.service';

function nullable(value:FinanceV1.NullableStringChange|undefined):{present:false}|{present:true;value:string|null} {
  if(value===undefined)return {present:false}; const hasValue=value.value!==undefined,hasClear=value.clear!==undefined;
  if(hasValue===hasClear||(hasClear&&value.clear!==true))throw new FinanceReadError('VALIDATION_FAILED');
  return {present:true,value:hasClear?null:value.value!};
}
@Injectable()
export class FinancialNoteService {
  constructor(private readonly db:DatabaseProvider,private readonly rows:FinancialNoteRepository,private readonly auth:FundQueryService,private readonly commands:FundCommandService) {}
  async list(request:FinanceV1.ListFinancialNotesRequest,correlation:string,deadline:number):Promise<FinanceV1.ListFinancialNotesResponse>{
    const actor=readUuid(request.actor_user_id),page=parseFinancialNotePage(request); await this.auth.authorizeFundRead(page.fundId,actor,correlation,deadline); const result=await this.rows.list(page); return {items:result.items.map(row=>financialNoteResponse(row,result.financeVersion)),next_cursor:result.nextCursor};
  }
  async create(request:FinanceV1.CreateFinancialNoteRequest,correlation:string,deadline:number){
    const operationId=readUuid(request.operation_id),actor=readUuid(request.actor_user_id),fundId=readUuid(request.fund_id); const body=parseCreateFinancialNote({description:request.description,amount:request.amount,payer_user_id:request.payer_user_id,expected_finance_version:request.expected_finance_version}); return this.run({scope:'CREATE_FINANCIAL_NOTE',fundId,body},operationId,actor,correlation,deadline);
  }
  async manage(scope:'UPDATE_FINANCIAL_NOTE'|'DELETE_FINANCIAL_NOTE',request:FinanceV1.UpdateFinancialNoteRequest|FinanceV1.DeleteFinancialNoteRequest,correlation:string,deadline:number){
    const operationId=readUuid(request.operation_id),actor=readUuid(request.actor_user_id),noteId=readUuid(request.note_id); const found=(await this.db.query<{fund_id:string}>('SELECT fund_id FROM financial_notes WHERE id=$1 AND deleted_at IS NULL',[noteId])).rows[0]; if(!found)throw new FinanceReadError('RESOURCE_NOT_FOUND');
    let body;
    if(scope==='UPDATE_FINANCIAL_NOTE') { const update=request as FinanceV1.UpdateFinancialNoteRequest,amount=nullable(update.amount),payer=nullable(update.payer_user_id); body=parseUpdateFinancialNote({...((update.description===undefined)?{}:{description:update.description}),...(amount.present?{amount:amount.value}:{}),...(payer.present?{payer_user_id:payer.value}:{}),expected_version:update.expected_version,expected_finance_version:update.expected_finance_version}); }
    else body=parseFinancialNoteAction({expected_version:request.expected_version,expected_finance_version:request.expected_finance_version});
    return this.run({scope,fundId:found.fund_id,noteId,body} as FinancialNoteWriteCommand,operationId,actor,correlation,deadline);
  }
  private async run(mutation:FinancialNoteWriteCommand,operationId:string,actor:string,correlation:string,deadline:number){ const fund=(await this.db.query<{trip_id:string}>('SELECT trip_id FROM funds WHERE id=$1',[mutation.fundId])).rows[0]; if(!fund)throw new FinanceReadError('RESOURCE_NOT_FOUND'); return this.commands.run({...mutation,operationId,actor,tripId:fund.trip_id},correlation,deadline); }
}
