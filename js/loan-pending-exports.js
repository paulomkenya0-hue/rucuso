// A real OOXML .xlsx workbook, with inline text cells (never Excel formulas).
// ZIP uses the STORE method so no compressor/CDN is required for Excel exports.
(function(){
 'use strict';
 const xml=s=>String(s??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const enc=new TextEncoder();
 function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
 function zip(files){const chunks=[],central=[];let offset=0,centralSize=0;
  for(const[name,text]of Object.entries(files)){const filename=enc.encode(name),data=enc.encode(text),crc=crc32(data),header=new Uint8Array(30+filename.length),h=new DataView(header.buffer);
   h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,filename.length,true);header.set(filename,30);
   const entry=new Uint8Array(46+filename.length),d=new DataView(entry.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,filename.length,true);d.setUint32(42,offset,true);entry.set(filename,46);
   chunks.push(header,data);central.push(entry);offset+=header.length+data.length;centralSize+=entry.length;
  }
  const end=new Uint8Array(22),d=new DataView(end.buffer);d.setUint32(0,0x06054b50,true);d.setUint16(8,central.length,true);d.setUint16(10,central.length,true);d.setUint32(12,centralSize,true);d.setUint32(16,offset,true);
  const result=new Uint8Array(offset+centralSize+22);let at=0;for(const part of [...chunks,...central,end]){result.set(part,at);at+=part.length;}return result;
 }
 const columns=['Na.','Majina matatu','Registration number','Index number','Benki','Namba ya akaunti'];
 function grid(rows){return rows.map((r,i)=>[String(i+1),r.full_name,r.registration_number,r.index_number,r.bank==='OTHER'?r.bank_other:r.bank,r.account_number]);}
 function xlsx(rows,title,filters){
  const data=[[title+' — Wanafunzi '+rows.length],[filters],columns,...grid(rows)];
  const body=data.map((r,i)=>`<row r="${i+1}">`+r.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"${i===2?' s="1"':''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')+'</row>').join('');
  return zip({
   '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
   'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sample za Pending" sheetId="1" r:id="rId1"/></sheets></workbook>',
   'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
   'xl/styles.xml':'<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
   'xl/worksheets/sheet1.xml':'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="7" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="4" width="26" customWidth="1"/><col min="5" max="5" width="22" customWidth="1"/><col min="6" max="6" width="34" customWidth="1"/></cols><sheetData>'+body+'</sheetData><autoFilter ref="A3:F'+data.length+'"/></worksheet>'
  });
 }
 function pdf(rows,title,filters){
  if(!window.jspdf?.jsPDF)throw new Error('PDF_LIBRARY_UNAVAILABLE');
  const doc=new window.jspdf.jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const widths=[8,65,55,45,40,60];let y=0;
  function header(){doc.setFont('helvetica','bold');doc.setFontSize(12);const titleLines=doc.splitTextToSize('RUCUSO — '+title,270);doc.text(titleLines,12,12);y=14+titleLines.length*5;doc.setFont('helvetica','normal');doc.setFontSize(8);const lines=doc.splitTextToSize(filters+' | Wanafunzi: '+rows.length,270);doc.text(lines,12,y);y+=lines.length*4+4;doc.setFont('helvetica','bold');let x=12;columns.forEach((v,i)=>{doc.text(doc.splitTextToSize(v,widths[i]-2),x+1,y);x+=widths[i];});y+=9;doc.setFont('helvetica','normal');}
  header();
  for(const row of grid(rows)){doc.setFontSize(7.5);const wrapped=row.map((v,i)=>doc.splitTextToSize(String(v),widths[i]-2));const height=Math.max(...wrapped.map(x=>x.length))*3.5+4;if(y+height>195){doc.addPage();header();doc.setFontSize(7.5);}let x=12;wrapped.forEach((v,i)=>{doc.text(v,x+1,y+3);x+=widths[i];});doc.setDrawColor(220);doc.line(12,y+height,285,y+height);y+=height;}
  const pages=doc.getNumberOfPages();for(let i=1;i<=pages;i++){doc.setPage(i);doc.setFontSize(7);doc.text(`Taarifa binafsi — Waziri wa Mikopo / super admin | Ukurasa ${i}/${pages}`,12,204);}return doc;
 }
 window.RucusoLoanPendingExports={xlsx,pdf,grid};
})();
