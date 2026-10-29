/**
 * SampleData.js
 * ใส่/ลบข้อมูลตัวอย่างใน Sheet เพื่อดูหน้าตาและลองใช้งาน
 *
 *   loadSampleData()   เพิ่มพนักงานตัวอย่าง E002–E006, สถานที่ทำงานเพิ่ม 1 แห่ง
 *                       และประวัติลงเวลาย้อนหลัง 5 วันทำงาน (ทำซ้ำได้ ไม่ซ้ำซ้อน)
 *   clearSampleData()  ลบเฉพาะที่ loadSampleData เพิ่มไว้ (ข้อมูลจริงไม่ถูกแตะ)
 *
 * แถวประวัติตัวอย่างมีคอลัมน์ "อุปกรณ์" = ข้อมูลตัวอย่าง
 */

var SAMPLE_TAG_ = 'ข้อมูลตัวอย่าง';
var SAMPLE_EMPLOYEES_ = [
  ['E002', 'สมหญิง รักงาน', 'บัญชี'],
  ['E003', 'ประเสริฐ ดีเลิศ', 'คลังสินค้า'],
  ['E004', 'นภา สุขใจ', 'ฝ่ายขาย'],
  ['E005', 'วิชัย มั่นคง', 'ขนส่ง'],
  ['E006', 'อรทัย ใจงาม', 'บุคคล']
];
var SAMPLE_SITE_ = { name: 'สาขาสยาม (ตัวอย่าง)', lat: 13.7456, lng: 100.5341, radius: 150 };
var SAMPLE_ADDRESSES_ = {
  main: 'ถนนทดสอบ แขวงพระบรมมหาราชวัง เขตพระนคร กรุงเทพมหานคร 10200',
  siam: 'ถนนพระราม 1 แขวงปทุมวัน เขตปทุมวัน กรุงเทพมหานคร 10330',
  client: 'ถนนพหลโยธิน แขวงจตุจักร เขตจตุจักร กรุงเทพมหานคร 10900'
};

function loadSampleData() {
  ensureSchema_();
  var added = { employees: 0, sites: 0, logs: 0 };

  var haveEmp = {};
  dbAll_('employees').forEach(function (e) { haveEmp[normId_(e.id)] = true; });
  SAMPLE_EMPLOYEES_.forEach(function (r) {
    if (haveEmp[r[0]]) return;
    dbAppend_('employees', { id: r[0], name: r[1], dept: r[2], active: true, regCode: '', regExpires: '' });
    added.employees++;
  });

  var haveSite = dbAll_('sites').some(function (s) { return String(s.name) === SAMPLE_SITE_.name; });
  if (!haveSite) {
    dbAppend_('sites', { name: SAMPLE_SITE_.name, lat: SAMPLE_SITE_.lat, lng: SAMPLE_SITE_.lng, radius: SAMPLE_SITE_.radius, active: true });
    added.sites++;
  }

  var logDef = SHEETS_.log, hasSample = dbAll_('log').some(function (r) { return String(r.device) === SAMPLE_TAG_; });
  if (!hasSample) {
    var rows = buildSampleLogs_();
    if (rows.length) {
      var sh = sheet_('log');
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, logDef.cols.length).setValues(rows);
      added.logs = rows.length;
    }
  }

  try { drawButtons_(); } catch (e) { /* ยังไม่ได้ติดตั้งปุ่ม */ }

  var msg = 'เพิ่มข้อมูลตัวอย่างแล้ว: พนักงาน ' + added.employees + ' คน, สถานที่ ' + added.sites + ' แห่ง, ประวัติลงเวลา ' + added.logs + ' รายการ' +
    '\nลบออกได้ด้วยฟังก์ชัน clearSampleData';
  console.log(msg);
  uiAlert_(msg);
  return added;
}

function clearSampleData() {
  ensureSchema_();
  var removed = { employees: 0, sites: 0, logs: 0 };
  var sample = {};
  SAMPLE_EMPLOYEES_.forEach(function (r) { sample[r[0]] = r[1]; });

  removed.logs = deleteRows_('log', dbAll_('log').filter(function (r) { return String(r.device) === SAMPLE_TAG_; }));
  removed.employees = deleteRows_('employees', dbAll_('employees').filter(function (e) {
    var id = normId_(e.id);
    return sample[id] !== undefined && String(e.name) === sample[id] && activeDevicesOf_(id).length === 0;
  }));
  removed.sites = deleteRows_('sites', dbAll_('sites').filter(function (s) { return String(s.name) === SAMPLE_SITE_.name; }));

  var msg = 'ลบข้อมูลตัวอย่างแล้ว: พนักงาน ' + removed.employees + ' คน, สถานที่ ' + removed.sites + ' แห่ง, ประวัติลงเวลา ' + removed.logs + ' รายการ';
  console.log(msg);
  uiAlert_(msg);
  return removed;
}

function deleteRows_(key, objs) {
  var sh = sheet_(key);
  objs.map(function (o) { return o._row; }).sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });
  return objs.length;
}

function buildSampleLogs_() {
  var cols = SHEETS_.log.cols, sites = activeSites_();
  var emps = dbAll_('employees'), nameOf = {};
  emps.forEach(function (e) { nameOf[normId_(e.id)] = String(e.name); });
  var main = sites[0] || { lat: 13.7563, lng: 100.5018 };
  var siam = { lat: SAMPLE_SITE_.lat, lng: SAMPLE_SITE_.lng };

  // 5 วันทำงานล่าสุดก่อนวันนี้
  var days = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  while (days.length < 5) {
    d = new Date(d.getTime() - 86400000);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.unshift(new Date(d.getTime()));
  }

  // ตารางลงเวลา: [รหัส, จุดที่ไป, เวลาเข้า (นาทีจาก 00:00), เวลาออก]
  var plan = [
    ['E001', 'main', 8 * 60 + 41, 17 * 60 + 36],
    ['E002', 'main', 8 * 60 + 52, 17 * 60 + 5],
    ['E003', 'siam', 7 * 60 + 58, 17 * 60 + 2],
    ['E004', 'main', 9 * 60 + 12, 18 * 60 + 24],
    ['E005', 'main', 8 * 60 + 25, 17 * 60 + 48]
  ];
  var seed = 7;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

  var out = [];
  days.forEach(function (day, di) {
    plan.forEach(function (p) {
      if (!nameOf[p[0]]) return;
      if (p[0] === 'E005' && di === 2) return; // ลาหนึ่งวัน
      var base = p[1] === 'siam' ? siam : main;
      var field = (p[0] === 'E004' && di === 3); // ไปพบลูกค้า นอกพื้นที่
      [['เข้างาน', p[2]], ['ออกงาน', p[3]]].forEach(function (t, ti) {
        var mins = t[1] + Math.round((rnd() - 0.5) * 24);
        var ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60, Math.floor(rnd() * 60));
        var centre = field ? { lat: 13.8021, lng: 100.5537 } : base;
        var geo = {
          lat: centre.lat + (rnd() - 0.5) * 0.0008, lng: centre.lng + (rnd() - 0.5) * 0.0008,
          accuracy: 8 + Math.round(rnd() * 30)
        };
        var loc = evaluateLocation_(geo, sites);
        var rec = {
          ts: ts, date: dateText_(ts), time: Utilities.formatDate(ts, tz_(), 'HH:mm:ss'),
          empId: p[0], name: nameOf[p[0]], type: TYPE_LABEL_[ti === 0 ? TYPE_IN : TYPE_OUT],
          lat: Number(geo.lat.toFixed(6)), lng: Number(geo.lng.toFixed(6)), accuracy: geo.accuracy,
          address: field ? SAMPLE_ADDRESSES_.client : (p[1] === 'siam' ? SAMPLE_ADDRESSES_.siam : SAMPLE_ADDRESSES_.main),
          site: loc.site ? loc.site.name : '', distance: loc.distance === undefined ? '' : loc.distance,
          status: STATUS_LABEL_[loc.status], mapUrl: mapUrl_(geo.lat, geo.lng), device: SAMPLE_TAG_
        };
        out.push(rec);
      });
    });
  });
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out.map(function (rec) { return cols.map(function (c) { return rec[c] === undefined ? '' : rec[c]; }); });
}
