import type {z} from 'zod';
import type {importRowSchema} from './schemas';

export const IMPORT_MAX_ROWS=20000,IMPORT_MAX_BYTES=20_000_000,IMPORT_CHUNK_SIZE=500;
export const importFields=[
  {key:'company',label:'Tên đại lý / công ty'},
  {key:'email',label:'Email liên hệ',required:true},
  {key:'name',label:'Tên người liên hệ'},
  {key:'title',label:'Chức danh / bộ phận'},
  {key:'website',label:'Website công ty'},
  {key:'region',label:'Khu vực / tỉnh thành'},
  {key:'segment',label:'Phân khúc'},
  {key:'market',label:'Thị trường'},
  {key:'tier',label:'Nhóm giá'},
  {key:'notes',label:'Ghi chú đại lý'},
  {key:'source',label:'Nguồn dữ liệu'},
  {key:'country',label:'Quốc gia liên hệ'},
] as const;
export type ImportField=typeof importFields[number]['key'];
export type ImportRecord=z.infer<typeof importRowSchema>;
export type ImportSheet={name:string;rows:string[][]};
export type ImportMapping=Record<string,ImportField|''>;
export type MappedImportRow={row:number;data:Record<string,string>};
export type ImportPreview={filename:string;records:ImportRecord[];errors:{row:number;error:string}[];errorTotal:number;duplicates:number;conflicts:number;total:number};
export type ImportProgress={id:string;total:number;processed:number;imported:number;skipped:number;nextChunk:number;status:'running'|'completed'};

export const importKey=(s:string)=>s.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase();
const aliases:Record<string,ImportField>={company:'company',companyname:'company',agency:'company',agencyname:'company',congty:'company',tendaily:'company',tencongty:'company',doanhnghiep:'company',email:'email',emailaddress:'email',emailcontact:'email',email1:'email',thudientu:'email',name:'name',fullname:'name',contactname:'name',hoten:'name',tenlienhe:'name',nguoilienhe:'name',title:'title',position:'title',chucvu:'title',chucdanh:'title',bophan:'title',website:'website',web:'website',trangweb:'website',region:'region',city:'region',province:'region',khuvuc:'region',tinhthanh:'region',thanhpho:'region',segment:'segment',phankhuc:'segment',source:'source',nguon:'source',nguondulieu:'source',country:'country',quocgia:'country',market:'market',thitruong:'market',tier:'tier',nhomgia:'tier',notes:'notes',note:'notes',ghichu:'notes'};
export function suggestImportMapping(headers:string[]):ImportMapping{
  const seen=new Set<ImportField>();return Object.fromEntries(headers.map((header,i)=>{const field=aliases[importKey(header).replace(/[^a-z0-9]/g,'')];if(field&&!seen.has(field)){seen.add(field);return [String(i),field];}return [String(i),''];}));
}
export function sheetImportData(sheet:ImportSheet,headerRow:number){
  const start=headerRow-1,columns=sheet.rows.slice(start).reduce((max,row)=>Math.max(max,row.length),0);
  const headers=Array.from({length:columns},(_,i)=>sheet.rows[start]?.[i]?.trim()||`Cột ${i+1} (trống)`);
  const entries=sheet.rows.slice(start+1).map((values,i)=>({row:start+i+2,values})).filter(row=>row.values.some(value=>value.trim()));
  return {headers,entries};
}
export function mapImportRows(sheet:ImportSheet,headerRow:number,mapping:ImportMapping,source:string):MappedImportRow[]{
  return sheetImportData(sheet,headerRow).entries.map(entry=>{
    const data:Record<string,string>={};for(const [index,target]of Object.entries(mapping))if(target&&importFields.some(field=>field.key===target))data[target]=entry.values[Number(index)]||'';
    if(!data.source?.trim())data.source=source;
    return {row:entry.row,data};
  });
}
export function normalizeImportRecord(data:Record<string,string>){
  const result:Record<string,string>={};for(const field of importFields)if(typeof data[field.key]==='string')result[field.key]=data[field.key].trim();
  result.country=!result.country?'':['vn','vnm','vietnam','viet nam'].includes(importKey(result.country))?'VN':'OTHER';
  if(result.website&&!/^[a-z][a-z0-9+.-]*:/i.test(result.website))result.website='https://'+result.website;
  return result;
}
