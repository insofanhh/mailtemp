import Papa from 'papaparse';
import readXlsx from 'read-excel-file/node';
import {unzipSync} from 'fflate';
import {IMPORT_MAX_BYTES,IMPORT_MAX_ROWS,type ImportSheet} from './import-data';

export async function readImportFile(file:File):Promise<ImportSheet[]>{
  if(!file.size||file.size>IMPORT_MAX_BYTES)throw new Error('Chọn tệp CSV hoặc XLSX tối đa 20 MB.');
  let sheets:ImportSheet[];
  if(file.name.toLowerCase().endsWith('.csv')){
    const parsed=Papa.parse<string[]>(await file.text(),{header:false,skipEmptyLines:false});
    const error=parsed.errors.find(error=>error.code!=='UndetectableDelimiter');if(error)throw new Error('CSV sai định dạng: '+error.message);
    sheets=[{name:'CSV',rows:parsed.data}];
  }else if(file.name.toLowerCase().endsWith('.xlsx')){
    const buffer=Buffer.from(await file.arrayBuffer());let expanded=0,files=0;
    unzipSync(buffer,{filter:entry=>{expanded+=entry.originalSize;if(expanded>100_000_000||++files>500)throw new Error('Tệp Excel giải nén quá lớn (tối đa 100 MB / 500 thành phần).');return false;}});
    sheets=(await readXlsx(buffer)).map(sheet=>({name:sheet.sheet,rows:sheet.data.map(row=>Array.from(row,cell=>cell instanceof Date?cell.toISOString().slice(0,10):String(cell??'')))}));
  }else throw new Error('Chỉ hỗ trợ CSV và XLSX.');
  let cells=0;
  for(const sheet of sheets){
    while(sheet.rows.length&&!sheet.rows.at(-1)!.some(cell=>cell.trim()))sheet.rows.pop();
    if(sheet.rows.length>IMPORT_MAX_ROWS+50)throw new Error('Mỗi sheet tối đa 20.000 dòng dữ liệu và 50 dòng tiêu đề/giới thiệu.');
    for(const row of sheet.rows){cells+=row.length;if(row.length>200||row.some(cell=>cell.length>20000))throw new Error('Tệp tối đa 200 cột, mỗi ô tối đa 20.000 ký tự.');}
  }
  if(cells>2_000_000||sheets.length>30)throw new Error('Tệp quá nhiều ô hoặc sheet (tối đa 2 triệu ô / 30 sheet).');
  sheets=sheets.filter(sheet=>sheet.rows.length);
  if(!sheets.length)throw new Error('Tệp không có dữ liệu.');
  if(Buffer.byteLength(JSON.stringify(sheets))>40_000_000)throw new Error('Nội dung tệp sau khi đọc vượt 40 MB. Hãy bỏ các cột hoặc sheet không cần.');
  return sheets;
}
