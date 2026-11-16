import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {signPlaceSelection}=require('../packages/common/dist/index.js');
// Runs only inside the existing disposable integration infrastructure.
export async function runLocationScenarios({request,query,bearer,tripBody,pass,owner,member,outsider,secret}) {
  const created=await request('/api/v1/trips','POST',tripBody('POI integration'),bearer(owner));
  assert.equal(created.status,201);
  const trip=created.body.data,base=`/api/v1/trips/${trip.id}`;
  let version=trip.plan_version;
  const status=(response,expected)=>assert.equal(response.status,expected,JSON.stringify(response.body));
  const send=async(method,path,body={},user=owner,key=randomUUID(),expected=version)=>{
    const r=await request(base+path,method,{...body,expected_plan_version:expected},{...bearer(user),'idempotency-key':key});
    if(r.status<300)version=r.body.data.version?.plan_version??r.body.data.plan_version;
    return r;
  };
  await query('trip',"INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",[trip.id,member.id]);
  await query('trip',"UPDATE trips SET plan_edit_policy='OWNER_ONLY' WHERE id=$1",[trip.id]);
  status(await send('POST','/selected-locations',{name:'manual',latitude:16,longitude:108},member),403);
  status(await send('POST','/selected-locations',{name:'manual',latitude:16,longitude:108},outsider),404);
  status(await send('POST','/selected-locations',{name:'manual',latitude:'16',longitude:108}),400);
  status(await send('POST','/selected-locations',{name:'manual',latitude:16,longitude:108},owner,randomUUID(),'1'),400);
  const key=randomUUID(),initial=version,manual={name:'Manual pin',latitude:16.0544,longitude:108.2022};
  const first=await send('POST','/selected-locations',manual,owner,key,initial);status(first,201);
  const replay=await send('POST','/selected-locations',manual,owner,key,initial);status(replay,201);assert.deepEqual(first.body.data,replay.body.data);
  status(await send('POST','/selected-locations',{...manual,name:'changed'},owner,key,initial),409);
  status(await send('POST','/selected-locations',manual,owner,randomUUID(),initial),409);
  pass('locations: real DB manual save/replay, payload/version conflicts and viewer/outsider denial');
  const snapshot={actor:owner.id,trip:trip.id,expires:Date.now()+60000,place:{provider:'GEOAPIFY',provider_place_id:'a'.repeat(600),name:'Hoi An',address:'Vietnam',latitude:15.88,longitude:108.33,categories:['tourism'],fetched_at:new Date().toISOString(),attribution:'Geoapify / OSM'}};
  const token=signPlaceSelection(snapshot,secret);
  status(await send('POST','/selected-locations',{selection_token:token,name:'spoof'}),400);
  status(await send('POST','/selected-locations',{selection_token:signPlaceSelection({...snapshot,trip:randomUUID()},secret)}),400);
  status(await send('POST','/selected-locations',{selection_token:signPlaceSelection({...snapshot,expires:1},secret)}),400);
  const provider=await send('POST','/selected-locations',{selection_token:token});status(provider,201);
  const duplicate=await send('POST','/selected-locations',{selection_token:token});status(duplicate,201);assert.deepEqual(duplicate.body.data,provider.body.data);
  const plan=await request(base+'/plan','GET',undefined,bearer(owner));status(plan,200);
  assert.equal(plan.body.data.selected_locations.length,2);
  assert.equal(plan.body.data.selected_locations.find(p=>p.source==='PROVIDER').provider_place_id,snapshot.place.provider_place_id);
  const location=provider.body.data.location_id;
  const activity=await send('POST','/activities',{title:'Visit Hoi An',activity_type:'VISIT',position:0,scheduled_date:trip.start_at.slice(0,10),selected_location_id:location});status(activity,201);
  status(await send('DELETE',`/selected-locations/${location}`),409);
  const refreshed=await request(base+'/plan','GET',undefined,bearer(owner));
  assert.equal(refreshed.body.data.activities[0].selected_location_id,location);
  status(await send('DELETE',`/selected-locations/${first.body.data.location_id}`),200);
  pass('locations: signed provider snapshot, 600-char ID, duplicate dedup, attach/reload and delete-used conflict');
}
