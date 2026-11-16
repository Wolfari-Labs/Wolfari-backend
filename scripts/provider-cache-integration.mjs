import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PlacesService}=require('../apps/travel-intelligence-service/dist/places.service.js');
const {PriceWatchWorkerRepository}=require('../apps/automation-service/dist/price-watch/price-watch-worker.repository.js');
const {PriceAlertRepository}=require('../apps/automation-service/dist/price-watch/price-alert.repository.js');
const {parseTravelpayouts}=require('../apps/automation-service/dist/price-watch/travelpayouts.provider.js');

export async function checkPlacesCache(client) {
 const fetcher=globalThis.fetch;let calls=0;
 await client.query('BEGIN');
 try{
  const values={GEOAPIFY_API_KEY:'integration-not-a-real-key',PLACE_SELECTION_SECRET:'s'.repeat(64)};
  const service=new PlacesService({query:client.query.bind(client)},{get:key=>values[key]});
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({features:[{properties:{place_id:'id',name:'Hoi An',lat:15.88,lon:108.33}}]}));};
  const input={actor_user_id:randomUUID(),trip_id:randomUUID(),query:'',coordinates:{latitude:16,longitude:108},radius_m:5000};
  const first=await service.search(input);assert.equal(first.data.length,1);
  const again=await service.search(input);assert.equal(again.meta.stale,false);assert.equal(calls,1);
  const cached=(await client.query("SELECT * FROM provider_cache WHERE provider='GEOAPIFY'")).rows[0];
  assert.equal(cached.expires_at-cached.fetched_at,86400000);
  await client.query("UPDATE provider_cache SET fetched_at=now()-interval '2 days',expires_at=now()-interval '1 day'");
  await client.query("UPDATE provider_usage SET last_call_at=now()-interval '2 seconds'");
  globalThis.fetch=async()=>new Response('',{status:429});
  const stale=await service.search(input);assert.equal(stale.meta.stale,true);assert.equal(stale.data.length,1);assert.deepEqual(stale.meta.warnings,['PROVIDER_RATE_LIMITED']);
  await client.query('DELETE FROM provider_cache');await client.query("UPDATE provider_usage SET last_call_at=now()-interval '2 seconds'");
  globalThis.fetch=async()=>new Response('{"features":[]}');
  assert.equal((await service.search(input)).data.length,0);
  const empty=(await client.query('SELECT * FROM provider_cache')).rows[0];assert.equal(empty.expires_at-empty.fetched_at,300000);
 }finally{globalThis.fetch=fetcher;await client.query('ROLLBACK');}
}
export async function checkCachedPriceAlerts(client) {
 const database={query:client.query.bind(client),withTransaction:work=>work(client)};
 const worker=new PriceWatchWorkerRepository(database),alerts=new PriceAlertRepository(database);
 await client.query('BEGIN');
 try{
  const query={provider:'TRAVELPAYOUTS_CACHE',origin:'HAN',destination:'DAD',departure_date:'2099-11-01'};
  const group=(await client.query(`INSERT INTO price_query_groups(provider,transport_type,canonical_key,origin,destination,departure_date,passenger_count,cabin_class,currency,params,active,next_check_at)
   VALUES('TRAVELPAYOUTS_CACHE','FLIGHT',$1,'HAN','DAD','2099-11-01',1,'ECONOMY','VND',$2,true,now()) RETURNING id`,[randomUUID(),JSON.stringify(query)])).rows[0];
  const membership=randomUUID();
  const watch=(await client.query(`INSERT INTO price_watches(query_group_id,user_id,trip_id,owner_membership_id,threshold_price,currency,status,expires_at,client_request_id,request_hash)
   VALUES($1,$2,$3,$4,2000000,'VND','ACTIVE','2099-11-01T00:00:00Z',$5,'cache-test') RETURNING id`,[group.id,randomUUID(),randomUUID(),membership,randomUUID()])).rows[0];
  let slot=0;
  for(const found of [null,new Date(Date.now()-72*3600000).toISOString(),new Date(Date.now()-3600000).toISOString()]){
   const parsed=parseTravelpayouts({success:true,data:[{origin:'HAN',destination:'DAD',depart_date:'2099-11-01',return_date:'',trip_class:0,value:1500000,found_at:found}]},query,true);
   const attempt=(await client.query(`INSERT INTO price_query_attempts(query_group_id,scheduled_slot,status,claim_owner,claim_until,attempt_count,next_attempt_at)
    VALUES($1,$2,'RUNNING','cache-worker',clock_timestamp()+interval '1 minute',1,clock_timestamp()) RETURNING *`,[group.id,new Date(Date.UTC(2098,0,1,slot*6))])).rows[0];
   assert.equal(await worker.completeSuccess('cache-worker',attempt,parsed),true);
   assert.equal(await worker.completeSuccess('cache-worker',attempt,parsed),false);
   assert.equal((await client.query('SELECT count(*)::int AS n FROM price_alert_candidates WHERE watch_id=$1',[watch.id])).rows[0].n,slot===2?1:0);
   slot++;
  }
  const candidate=await alerts.claimNext('cache-alert',30000);assert.equal(candidate.watch_id,watch.id);
  assert.equal(await alerts.completeNotification('cache-alert',candidate,membership),'NOTIFIED');
  const notifications=(await client.query('SELECT title,body FROM notifications WHERE source_id=$1',[watch.id])).rows;
  assert.equal(notifications.length,1);assert.match(notifications[0].body,/Travelpayouts/);assert.doesNotMatch(notifications[0].title,/Mô phỏng/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM notification_deliveries')).rows[0].n,0);
  // Existing queued mock candidates must never become new production notifications.
  await client.query("UPDATE price_watches SET last_alert_at=NULL,last_alert_price=NULL,alert_armed=true WHERE id=$1",[watch.id]);
  const legacy=(await client.query(`INSERT INTO price_query_attempts(query_group_id,scheduled_slot,status,claim_owner,claim_until,attempt_count,next_attempt_at)
    VALUES($1,'2098-01-02T00:00:00Z','RUNNING','cache-worker',clock_timestamp()+interval '1 minute',1,clock_timestamp()) RETURNING *`,[group.id])).rows[0];
  await worker.completeSuccess('cache-worker',legacy,{price:'1400000',currency:'VND',provider:'MOCK_FLIGHT',fare_metadata:{}});
  const productionAlerts=new PriceAlertRepository(database,{get:key=>key==='NODE_ENV'?'production':undefined});
  const old=await productionAlerts.claimNext('production-alert',30000);assert.equal(old.watch_id,watch.id);
  assert.equal(await productionAlerts.completeNotification('production-alert',old,membership),'SUPPRESSED');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM notifications WHERE source_id=$1',[watch.id])).rows[0].n,1);
 }finally{await client.query('ROLLBACK');}
}
