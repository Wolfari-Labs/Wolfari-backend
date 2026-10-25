import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { financialNoteRoute, projectFinancialNote } from '../../../apps/api-gateway/src/financial-note-http';

const document=JSON.parse(readFileSync(resolve(process.cwd(),'docs/api/finance-notes.openapi.json'),'utf8'));
describe('Financial Notes OpenAPI',()=>{
  it('documents API107-110 paths and strict amount representation',()=>{expect(Object.keys(document.paths)).toEqual(['/api/v1/funds/{fund_id}/notes','/api/v1/notes/{id}']);expect(document.components.schemas.Money.pattern).toBe('^(0|[1-9][0-9]*)$');expect(document.components.schemas.UpdateFinancialNoteInput.anyOf).toHaveLength(3);});
  it('routes collection/item without accepting extra segments',()=>{expect(financialNoteRoute('/api/v1/funds/abc/notes')).toEqual({kind:'collection',fundId:'abc'});expect(financialNoteRoute('/api/v1/notes/abc')).toEqual({kind:'item',noteId:'abc'});expect(financialNoteRoute('/api/v1/notes/abc/x')).toBeUndefined();});
  it('projects nullable fields and exact int64 money',()=>{expect(projectFinancialNote({id:'11111111-1111-4111-8111-111111111111',fund_id:'22222222-2222-4222-8222-222222222222',description:'Taxi',amount:'9223372036854775807',created_by_user_id:'33333333-3333-4333-8333-333333333333',created_at:{seconds:'0',nanos:0},updated_at:{seconds:'0',nanos:0},version:1,finance_version:2})).toMatchObject({amount:'9223372036854775807',payer_user_id:null});});
});
