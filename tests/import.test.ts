import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {readImportFile} from '../src/lib/import-file';
import {IMPORT_MAX_ROWS,mapImportRows,sheetImportData,suggestImportMapping,normalizeImportRecord} from '../src/lib/import-data';
import {importRowSchema} from '../src/lib/schemas';

test('Vietnamese/English headers, repeated headers and skipped columns',()=>{
  const mapping=suggestImportMapping(['Tên công ty','Thư điện tử','Email','Chức danh','Cột riêng']);
  assert.deepEqual(mapping,{'0':'company','1':'email','2':'','3':'title','4':''});
  const sheet={name:'Data',rows:[['Giới thiệu'],['Đơn vị','Hòm thư','Bí mật'],[],['ABC','test@example.com','Không nhập']]};
  const result=mapImportRows(sheet,2,{'0':'company','1':'email','2':''},'Nguồn chung');
  assert.deepEqual(result,[{row:4,data:{company:'ABC',email:'test@example.com',source:'Nguồn chung'}}]);
  assert.equal(sheetImportData({name:'Late',rows:[['A'],...Array.from({length:12},()=>['x']),['x','','late']]},1).headers.length,3);
});

test('Import normalization and schema retain allowed fields only',()=>{
  const parsed=importRowSchema.parse(normalizeImportRecord({company:' ABC ',email:' TEST@EXAMPLE.COM ',website:'agency.example.com',country:'Việt Nam',source:' web ',consentStatus:'eligible'}));
  assert.equal(parsed.email,'test@example.com');assert.equal(parsed.website,'https://agency.example.com');
  assert.equal(parsed.country,'VN');assert.equal(parsed.segment,'');
  assert.ok(!('consentStatus' in parsed));
  assert.equal(normalizeImportRecord({country:'Thailand'}).country,'OTHER');
});

test('Only email is required; absent or blank optional fields stay blank',()=>{
  const cases:Record<string,string>[]=[{email:' PERSON@EXAMPLE.COM '},{email:'person@example.com',company:' ',source:' ',market:'',segment:'',tier:'',country:''}];
  for(const input of cases){
    const parsed=importRowSchema.parse(normalizeImportRecord(input));
    assert.equal(parsed.email,'person@example.com');
    for(const key of ['company','name','title','website','region','market','segment','tier','notes','source','country'] as const)assert.equal(parsed[key],'');
  }
  assert.equal(importRowSchema.safeParse({email:'invalid'}).success,false);
  const sheet={name:'Emails',rows:[['Email'],['person@example.com']]};
  assert.equal(mapImportRows(sheet,1,suggestImportMapping(['Email']),'')[0].data.email,'person@example.com');
});

test('CSV reads 20,000 data rows, preserves line numbers and rejects oversized structures',async()=>{
  const csv='company,email\n'+Array.from({length:IMPORT_MAX_ROWS},(_,i)=>`Agency,c${i}@example.com`).join('\n')+'\n';
  const [sheet]=await readImportFile(new File([csv],'large.csv'));
  const result=sheetImportData(sheet,1);
  assert.equal(result.entries.length,20000);assert.equal(result.entries.at(-1)?.row,20001);
  const [semicolon]=await readImportFile(new File(['company;email\nAgency;test@example.com'],'semicolon.csv'));
  assert.equal(semicolon.rows[1][1],'test@example.com');
  await assert.rejects(()=>readImportFile(new File(['x'.repeat(20001)],'cell.csv')),/20.000 ký tự/);
  await assert.rejects(()=>readImportFile(new File([Array.from({length:201},()=>1).join(',')],'columns.csv')),/200 cột/);
  await assert.rejects(()=>readImportFile(new File(['x\n'.repeat(20052)],'rows.csv')),/Mỗi sheet/);
  await assert.rejects(()=>readImportFile(new File(['bad'],'file.xls')),/CSV và XLSX/);
});

test('XLSX reads multiple sheets, sparse columns and typed cells',async()=>{
  const zip=zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Intro" sheetId="1" r:id="rId1"/><sheet name="Contacts" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Intro</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>company</t></is></c><c r="C1" t="inlineStr"><is><t>email</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Agency</t></is></c><c r="C2" t="inlineStr"><is><t>test@example.com</t></is></c><c r="D2"><v>42</v></c></row></sheetData></worksheet>',
  }).map(([name,value])=>[name,strToU8(value)])));
  const sheets=await readImportFile(new File([Buffer.from(zip)],'multi.xlsx'));
  assert.deepEqual(sheets.map(sheet=>sheet.name),['Intro','Contacts']);
  assert.deepEqual(sheets[1].rows[1],['Agency','','test@example.com','42']);
});
