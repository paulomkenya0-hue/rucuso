(function(){
 const roles={student:'Mwanafunzi',cr:'CR',mp:'Mbunge',minister:'Waziri'};
 const kinds={opinion:'Maoni',complaint:'Malalamiko',challenge:'Changamoto',suggestion:'Pendekezo',praise:'Pongezi'};
 const categories={teaching:'Ufundishaji',timetable:'Ratiba',exams:'Mitihani',results:'Matokeo',facilities:'Vifaa na mazingira ya kujifunzia',library:'Maktaba',other:'Mengine'};
 const reg=s=>String(s).replace(/\s/g,'').toUpperCase();
 const uuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
 function safeUrl(s){try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
 function error(e){const text=String(e?.message||e||'');
  if(/EDUCATION_CLOSED/.test(text))return 'Kupokea maoni ya elimu kumefungwa kwa sasa.';
  if(/DUPLICATE_SUBMISSION/.test(text))return 'Taarifa hii imeshatumwa hivi karibuni. Tumia kumbukumbu uliyopewa kuifuatilia.';
  if(/ACCOUNT_NOT_FOUND/.test(text))return 'Account ID haijapatikana. Mhusika aingie Google kwanza kwenye fomu ya Elimu.';
  if(/MP_NOT_FOUND/.test(text))return 'Chagua Mbunge amilifu kutoka orodha iliyopo ya Bunge.';
  return window.RucusoCommunity.error(e);
 }
 window.RucusoEducation={roles,kinds,categories,reg,uuid,safeUrl,error};
})();
