import { describe,expect,it } from 'vitest';
import { assertCanCreateFinancialNote, planFinancialNoteMutation } from './financial-note-management';
const creator='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',payer='33333333-3333-4333-8333-333333333333';
const context=(actor=creator)=>({actorUserId:actor,ownerUserId:owner,activeMemberUserIds:new Set([creator,owner,payer]),tripArchived:false,financeVersion:4,fundStatus:'OPEN'});
const state={createdByUserId:creator,description:'Taxi',amount:0n,payerUserId:payer,version:2};
describe('financial note rules',()=>{
 it('allows active member creation and zero amount',()=>expect(()=>assertCanCreateFinancialNote({description:'x',amount:0n,payerUserId:payer,expectedFinanceVersion:4},context())).not.toThrow());
 it('rejects inactive payer and stale versions',()=>{expect(()=>assertCanCreateFinancialNote({description:'x',amount:null,payerUserId:'44444444-4444-4444-8444-444444444444',expectedFinanceVersion:4},context())).toThrowError(/STATE_CONFLICT/);expect(()=>planFinancialNoteMutation({expectedVersion:1,expectedFinanceVersion:4},state,context())).toThrowError(/VERSION_CONFLICT/);});
 it('allows creator or owner and detects exact no-op',()=>{expect(planFinancialNoteMutation({description:'Taxi',amount:0n,payerUserId:payer,expectedVersion:2,expectedFinanceVersion:4},state,context())).toEqual({changed:false});expect(planFinancialNoteMutation({description:'Bus',expectedVersion:2,expectedFinanceVersion:4},state,context(owner))).toEqual({changed:true});});
 it('denies another active member',()=>expect(()=>planFinancialNoteMutation({expectedVersion:2,expectedFinanceVersion:4},state,context(payer))).toThrowError(/PERMISSION_DENIED/));
});
