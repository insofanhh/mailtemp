const defaultSegments=['Lữ hành','Khách đoàn','Tour ghép','MICE','Inbound','Outbound'];

export function accountSegmentOptions(accounts:ReadonlyArray<{segment?:unknown;deletedAt?:unknown}>){
  const segments=new Map(defaultSegments.map(value=>[value.toLocaleLowerCase('vi'),value]));
  const imported=accounts.filter(account=>!account.deletedAt).map(account=>typeof account.segment==='string'?account.segment.trim().normalize('NFC'):'').filter(Boolean).sort((a,b)=>a.localeCompare(b,'vi'));
  for(const value of imported){const key=value.toLocaleLowerCase('vi');if(!segments.has(key))segments.set(key,value);}
  return [...segments.values()].map(value=>({value,label:value}));
}
