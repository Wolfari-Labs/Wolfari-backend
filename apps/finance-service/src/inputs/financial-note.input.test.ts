import { describe, expect, it } from 'vitest';
import { parseCreateFinancialNote, parseFinancialNotePage, parseUpdateFinancialNote, financialNoteCursor } from './financial-note.input';

const fund='11111111-1111-4111-8111-111111111111';
describe('financial note inputs',()=>{
  it('normalizes description and preserves zero/null money states',()=>{
    expect(parseCreateFinancialNote({description:'  Taxi  ',amount:'0',payer_user_id:null,expected_finance_version:1})).toEqual({description:'Taxi',amount:0n,payerUserId:null,expectedFinanceVersion:1});
    expect(parseUpdateFinancialNote({amount:null,expected_version:2,expected_finance_version:3}).amount).toBeNull();
  });
  it.each([{description:' ',expected_finance_version:1},{description:'a\0b',expected_finance_version:1},{description:'x',amount:'9223372036854775808',expected_finance_version:1},{description:'x',extra:true,expected_finance_version:1}])('rejects invalid writes %#',(value)=>expect(()=>parseCreateFinancialNote(value)).toThrow());
  it('requires a mutable PATCH field',()=>expect(()=>parseUpdateFinancialNote({expected_version:1,expected_finance_version:1})).toThrow());
  it('scopes microsecond cursors to the fund',()=>{const cursor=financialNoteCursor({fundId:fund},{at:'2026-10-22T01:02:03.123456Z',id:'22222222-2222-4222-8222-222222222222'});expect(parseFinancialNotePage({fund_id:fund,cursor}).after?.at).toContain('123456');expect(()=>parseFinancialNotePage({fund_id:'33333333-3333-4333-8333-333333333333',cursor})).toThrow();});
});
