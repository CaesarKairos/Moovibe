export const CONTROL_ROOM_TIME_ZONE='America/Sao_Paulo';
export const PRODUCTIVITY_CACHE_TTL_MS=90000;
const fields=['created_at','details_fetched_at','enriched_at','embedded_at'];
const names=['added','details','enriched','embedded'];

const parts=(date,timeZone)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
function localMidnightUtc(year,month,day,timeZone=CONTROL_ROOM_TIME_ZONE){const target=Date.UTC(year,month-1,day);let guess=target;for(let i=0;i<4;i++){const p=parts(new Date(guess),timeZone),shown=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);guess+=target-shown;}return new Date(guess);}
const sqlTime=date=>date.toISOString().slice(0,19).replace('T',' ');
const localDateLabel=(date,timeZone=CONTROL_ROOM_TIME_ZONE)=>new Intl.DateTimeFormat('pt-BR',{timeZone,day:'2-digit',month:'2-digit'}).format(date);

export function productivityTimeBounds(now=new Date(),timeZone=CONTROL_ROOM_TIME_ZONE){
  const today=parts(now,timeZone),todayStart=localMidnightUtc(today.year,today.month,today.day,timeZone),days=[];
  for(let offset=6;offset>=0;offset--){const calendar=new Date(Date.UTC(today.year,today.month-1,today.day-offset)),start=localMidnightUtc(calendar.getUTCFullYear(),calendar.getUTCMonth()+1,calendar.getUTCDate(),timeZone),nextCalendar=new Date(Date.UTC(calendar.getUTCFullYear(),calendar.getUTCMonth(),calendar.getUTCDate()+1)),midnightEnd=localMidnightUtc(nextCalendar.getUTCFullYear(),nextCalendar.getUTCMonth()+1,nextCalendar.getUTCDate(),timeZone),end=new Date(Math.min(midnightEnd.getTime(),now.getTime()));days.push({label:localDateLabel(start,timeZone),start:sqlTime(start),end:sqlTime(end)});}
  const offsetName=new Intl.DateTimeFormat('en',{timeZone,timeZoneName:'longOffset'}).formatToParts(now).find(x=>x.type==='timeZoneName')?.value||'GMT';
  return {time_zone:timeZone,time_zone_label:`HORÁRIO DE BRASÍLIA · ${offsetName.replace('GMT','UTC').replace('-', '−')}`,now:sqlTime(now),today_start:sqlTime(todayStart),last_24h_start:sqlTime(new Date(now.getTime()-86400000)),last_7d_start:sqlTime(new Date(now.getTime()-7*86400000)),days};
}

export function productivitySql(bounds){
  const expressions=[];const binds=[];
  for(const [window,start] of [['today',bounds.today_start],['24h',bounds.last_24h_start],['7d',bounds.last_7d_start]])for(let i=0;i<fields.length;i++){expressions.push(`COALESCE(SUM(${fields[i]}>=? AND ${fields[i]}<?),0) AS ${names[i]}_${window}`);binds.push(start,bounds.now);}
  bounds.days.forEach((day,index)=>fields.slice(0,1).concat(fields.slice(2)).forEach((field,series)=>{expressions.push(`COALESCE(SUM(${field}>=? AND ${field}<?),0) AS chart_${index}_${['added','enriched','embedded'][series]}`);binds.push(day.start,day.end);}));
  return {sql:`SELECT ${expressions.join(',')} FROM movies`,binds};
}

export async function queryProductivity(db,now=new Date()){
  const bounds=productivityTimeBounds(now),{sql,binds}=productivitySql(bounds),row=await db.prepare(sql).bind(...binds).first();
  const window=name=>Object.fromEntries(names.map(metric=>[metric,Number(row?.[`${metric}_${name}`])||0]));
  return {available:true,cached:false,stale:false,generated_at:new Date(now).toISOString(),time_zone:bounds.time_zone,time_zone_label:bounds.time_zone_label,windows:{today:window('today'),'24h':window('24h'),'7d':window('7d')},chart:bounds.days.map((day,index)=>({date:day.label,added:Number(row?.[`chart_${index}_added`])||0,enriched:Number(row?.[`chart_${index}_enriched`])||0,embedded:Number(row?.[`chart_${index}_embedded`])||0}))};
}

let cache=null,pending=null;
export async function cachedProductivity(db,now=new Date()){
  if(cache&&now.getTime()-Date.parse(cache.generated_at)<PRODUCTIVITY_CACHE_TTL_MS)return {...cache,cached:true};
  if(pending)return pending;
  pending=queryProductivity(db,now).then(value=>(cache=value)).catch(error=>{console.warn(JSON.stringify({event:'admin_productivity_unavailable',error_class:error?.constructor?.name||'Error'}));return cache?{...cache,cached:true,stale:true,error:'QUERY_FAILED'}:{available:false,cached:false,stale:false,error:'QUERY_FAILED',time_zone:CONTROL_ROOM_TIME_ZONE,time_zone_label:'HORÁRIO DE BRASÍLIA'};}).finally(()=>{pending=null});
  return pending;
}

export function resetProductivityCache(){cache=null;pending=null;}
