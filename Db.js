/**
 * Db.js
 * โครงสร้าง Google Sheet และฟังก์ชันอ่าน/เขียนข้อมูล
 *
 * แผ่นงานที่ระบบสร้างให้อัตโนมัติ:
 *   บันทึกเวลา          ผลการลงเวลาทั้งหมด (แอปเขียนอย่างเดียว)
 *   พนักงาน             รายชื่อ + รหัสลงทะเบียนลายนิ้วมือ
 *   อุปกรณ์ลายนิ้วมือ    อุปกรณ์ที่ลงทะเบียนแล้ว (ปิดใช้งานได้ถ้าเครื่องหาย)
 *   สถานที่ทำงาน        จุดและรัศมีที่ถือว่า "อยู่ในพื้นที่"
 *   ตั้งค่า             ตัวเลือกของระบบ
 */

var SCHEMA_VERSION_ = '1';

var SHEETS_ = {
  log: {
    name: 'บันทึกเวลา',
    cols: ['ts', 'date', 'time', 'empId', 'name', 'type', 'lat', 'lng', 'accuracy', 'address', 'site', 'distance', 'status', 'mapUrl', 'device'],
    headers: ['เวลาบันทึก', 'วันที่', 'เวลา', 'รหัสพนักงาน', 'ชื่อ', 'ประเภท', 'ละติจูด', 'ลองจิจูด', 'ความแม่นยำ (ม.)', 'ที่อยู่', 'สถานที่ใกล้สุด', 'ระยะห่าง (ม.)', 'สถานะพื้นที่', 'แผนที่', 'อุปกรณ์'],
    text: [2, 3, 4],
    widths: [150, 90, 60, 90, 160, 80, 90, 90, 100, 320, 150, 100, 110, 260, 200]
  },
  employees: {
    name: 'พนักงาน',
    cols: ['id', 'name', 'dept', 'active', 'regCode', 'regExpires'],
    headers: ['รหัสพนักงาน', 'ชื่อ-นามสกุล', 'แผนก', 'ใช้งาน', 'รหัสลงทะเบียน', 'รหัสหมดอายุ'],
    text: [1, 5],
    widths: [110, 220, 160, 70, 140, 150]
  },
  devices: {
    name: 'อุปกรณ์ลายนิ้วมือ',
    cols: ['credId', 'empId', 'publicKey', 'alg', 'rpId', 'origin', 'signCount', 'device', 'createdAt', 'lastUsedAt', 'active'],
    headers: ['รหัสอุปกรณ์ (Credential ID)', 'รหัสพนักงาน', 'Public key', 'Alg', 'โดเมน (RP ID)', 'Origin', 'ตัวนับสแกน', 'ชื่ออุปกรณ์', 'ลงทะเบียนเมื่อ', 'ใช้ล่าสุด', 'ใช้งาน (ว่าง = ใช้งาน, FALSE = ปิด)'],
    text: [1, 2, 3, 5, 6],
    widths: [200, 100, 200, 60, 260, 300, 90, 220, 150, 150, 70]
  },
  sites: {
    name: 'สถานที่ทำงาน',
    cols: ['name', 'lat', 'lng', 'radius', 'active'],
    headers: ['ชื่อสถานที่', 'ละติจูด', 'ลองจิจูด', 'รัศมี (เมตร)', 'ใช้งาน (ว่าง = ใช้งาน, FALSE = ปิด)'],
    widths: [220, 110, 110, 110, 70]
  },
  settings: {
    name: 'ตั้งค่า',
    cols: ['key', 'value', 'desc'],
    headers: ['คีย์', 'ค่า', 'คำอธิบาย'],
    text: [1],
    widths: [200, 220, 520]
  }
};

var SETTING_DEFAULTS_ = [
  { key: 'COMPANY_NAME', value: 'บริษัทของคุณ', desc: 'ชื่อที่แสดงบนหน้าลงเวลา' },
  { key: 'REQUIRE_LOCATION', value: true, desc: 'บังคับให้ต้องได้ตำแหน่ง GPS ก่อนลงเวลา (TRUE/FALSE)' },
  { key: 'BLOCK_OUTSIDE', value: false, desc: 'ไม่ให้ลงเวลาเมื่ออยู่นอกรัศมีสถานที่ทำงาน (FALSE = ลงได้แต่บันทึกว่า "นอกพื้นที่")' },
  { key: 'REVERSE_GEOCODE', value: true, desc: 'แปลงพิกัดเป็นที่อยู่ให้อัตโนมัติ (ใช้โควตา Maps ของ Apps Script)' },
  { key: 'AUTO_WINDOW_HOURS', value: 16, desc: 'โหมดอัตโนมัติ: ถ้าบันทึกล่าสุดเป็น "เข้างาน" ภายในกี่ชั่วโมง ครั้งต่อไปจะเป็น "ออกงาน"' },
  { key: 'DUPLICATE_SECONDS', value: 30, desc: 'สแกนซ้ำภายในกี่วินาทีถือเป็นการกดซ้ำ ไม่บันทึกเพิ่ม' },
  { key: 'MAX_DEVICES', value: 5, desc: 'จำนวนอุปกรณ์สูงสุดต่อพนักงาน' },
  { key: 'CODE_VALID_HOURS', value: 72, desc: 'รหัสลงทะเบียนที่ระบบสร้างให้ ใช้ได้กี่ชั่วโมง' }
];

var SS_CACHE_ = null;

function ss_() {
  if (SS_CACHE_) return SS_CACHE_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) {
    SS_CACHE_ = SpreadsheetApp.openById(id);
    return SS_CACHE_;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props.getProperty('SHEET_ID');
    if (id) {
      SS_CACHE_ = SpreadsheetApp.openById(id);
    } else {
      var ss = SpreadsheetApp.getActiveSpreadsheet(); // ถ้าสคริปต์ผูกอยู่กับ Sheet ใช้ไฟล์นั้น
      if (!ss) ss = SpreadsheetApp.create('ระบบลงเวลาด้วยลายนิ้วมือ');
      props.setProperty('SHEET_ID', ss.getId());
      SS_CACHE_ = ss;
    }
  } finally {
    lock.releaseLock();
  }
  return SS_CACHE_;
}

var SCHEMA_BUSY_ = false;

function ensureSchema_(force) {
  if (SCHEMA_BUSY_) return; // กำลังสร้างอยู่ใน execution นี้ (เรียกซ้อนจาก seedDefaults_)
  var props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('SCHEMA_V') === SCHEMA_VERSION_ && props.getProperty('SHEET_ID')) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  SCHEMA_BUSY_ = true;
  try {
    if (!force && props.getProperty('SCHEMA_V') === SCHEMA_VERSION_ && props.getProperty('SHEET_ID')) return;
    var ss = ss_();
    Object.keys(SHEETS_).forEach(function (key) { prepareSheet_(ss, key); });
    removeBlankDefaultSheet_(ss);
    seedDefaults_();
    props.setProperty('SCHEMA_V', SCHEMA_VERSION_);
  } finally {
    SCHEMA_BUSY_ = false;
    lock.releaseLock();
  }
}

function prepareSheet_(ss, key) {
  var def = SHEETS_[key];
  var sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  var n = def.cols.length;
  sh.getRange(1, 1, 1, n).setValues([def.headers])
    .setFontWeight('bold').setBackground('#0F1E33').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  (def.text || []).forEach(function (c) { sh.getRange(2, c, rows, 1).setNumberFormat('@'); });
  (def.widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  if (key === 'log') sh.getRange(2, 1, rows, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  if (key === 'devices') sh.getRange(2, 9, rows, 2).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  if (key === 'employees') sh.getRange(2, 6, rows, 1).setNumberFormat('dd/MM/yyyy HH:mm');
}

function removeBlankDefaultSheet_(ss) {
  var sheets = ss.getSheets();
  if (sheets.length < 2) return;
  ['Sheet1', 'ชีต1', 'แผ่นงาน1'].forEach(function (nm) {
    var sh = ss.getSheetByName(nm);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() <= 1 && sh.getLastColumn() <= 1) ss.deleteSheet(sh);
  });
}

function seedDefaults_() {
  var have = {};
  dbAll_('settings').forEach(function (r) { have[String(r.key).trim()] = true; });
  SETTING_DEFAULTS_.forEach(function (d) {
    if (!have[d.key]) dbAppend_('settings', { key: d.key, value: d.value, desc: d.desc });
  });
  if (!dbAll_('sites').length) {
    // ตัวอย่าง: กลางกรุงเทพฯ แก้เป็นพิกัดสำนักงานจริงของคุณ
    dbAppend_('sites', { name: 'สำนักงานใหญ่ (ตัวอย่าง)', lat: 13.7563, lng: 100.5018, radius: 200, active: true });
  }
  if (!dbAll_('employees').length) {
    dbAppend_('employees', { id: 'E001', name: 'พนักงาน ตัวอย่าง', dept: 'ทั่วไป', active: true, regCode: '', regExpires: '' });
  }
}

/* ---------- อ่าน/เขียน ---------- */

function sheet_(key) {
  ensureSchema_();
  return ss_().getSheetByName(SHEETS_[key].name);
}

function rowToObj_(def, row, rowNum) {
  var o = { _row: rowNum };
  for (var i = 0; i < def.cols.length; i++) o[def.cols[i]] = row[i];
  return o;
}

function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) if (row[i] !== '' && row[i] !== null) return false;
  return true;
}

/** อ่านทุกแถว (ไม่รวมหัวตาราง) */
function dbAll_(key) {
  var def = SHEETS_[key];
  var sh = sheet_(key);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, def.cols.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (!isBlankRow_(vals[i])) out.push(rowToObj_(def, vals[i], i + 2));
  }
  return out;
}

/** อ่านเฉพาะ n แถวท้ายสุด (เร็วกว่าสำหรับชีตบันทึกเวลาที่โตเรื่อย ๆ) */
function dbTail_(key, n) {
  var def = SHEETS_[key];
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - n + 1);
  var vals = sh.getRange(start, 1, last - start + 1, def.cols.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (!isBlankRow_(vals[i])) out.push(rowToObj_(def, vals[i], start + i));
  }
  return out;
}

function dbAppend_(key, obj) {
  var def = SHEETS_[key];
  var sh = sheet_(key);
  var row = def.cols.map(function (c) { return obj[c] === undefined ? '' : obj[c]; });
  sh.appendRow(row);
  return sh.getLastRow();
}

function dbUpdate_(key, rowNum, patch) {
  var def = SHEETS_[key];
  var sh = sheet_(key);
  Object.keys(patch).forEach(function (k) {
    var idx = def.cols.indexOf(k);
    if (idx >= 0) sh.getRange(rowNum, idx + 1).setValue(patch[k]);
  });
}

/* ---------- ตั้งค่า ---------- */

function parseBool_(v) {
  if (v === true || v === false) return v;
  return /^(true|yes|y|1|ใช่|ใช้งาน|เปิด)$/i.test(String(v).trim());
}

/** คอลัมน์ "ใช้งาน": เว้นว่างถือว่าใช้งาน ปิดเฉพาะเมื่อใส่ FALSE / ไม่ / ปิด */
function isActive_(v) {
  if (v === false) return false;
  return !/^(false|no|n|0|ไม่ใช้|ไม่|ปิด)$/i.test(String(v === undefined || v === null ? '' : v).trim());
}

function getSettings_() {
  ensureSchema_();
  var map = {};
  dbAll_('settings').forEach(function (r) { map[String(r.key).trim()] = r.value; });
  var out = {};
  SETTING_DEFAULTS_.forEach(function (d) {
    var has = Object.prototype.hasOwnProperty.call(map, d.key) && map[d.key] !== '' && map[d.key] !== null;
    var v = has ? map[d.key] : d.value;
    if (typeof d.value === 'boolean') out[d.key] = parseBool_(v);
    else if (typeof d.value === 'number') out[d.key] = isFinite(Number(v)) ? Number(v) : d.value;
    else out[d.key] = String(v);
  });
  return out;
}
