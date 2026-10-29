/**
 * ระบบลงเวลาเข้า-ออกงานด้วยลายนิ้วมือ + บันทึกตำแหน่งอัตโนมัติ
 *
 * หลักการ
 *  - พนักงานลงทะเบียนมือถือของตัวเองครั้งเดียวด้วย "รหัสลงทะเบียน" ที่แอดมินให้
 *    ระบบผูกอุปกรณ์กับลายนิ้วมือผ่านมาตรฐาน WebAuthn (Passkey)
 *    ลายนิ้วมือจริงไม่ออกจากเครื่อง เซิร์ฟเวอร์เก็บเฉพาะ public key
 *  - ทุกครั้งที่ลงเวลา เบราว์เซอร์ให้ลายนิ้วมือเซ็นข้อความท้าทาย (challenge) แบบใช้ครั้งเดียว
 *    เซิร์ฟเวอร์ตรวจลายเซ็นเอง (WebAuthn.js) แล้วจึงบันทึกพร้อมพิกัด GPS
 *  - พิกัดแปลงเป็นที่อยู่ด้วย Maps service และคำนวณระยะจากสถานที่ทำงานที่กำหนดไว้
 *
 * ไฟล์: Code.js (ไฟล์นี้) / Db.js / WebAuthn.js / Index.html
 * เริ่มใช้งาน: ดู README.md
 */

var APP_VERSION = '1.0.0';
var TYPE_IN = 'IN';
var TYPE_OUT = 'OUT';
var TYPE_LABEL_ = { IN: 'เข้างาน', OUT: 'ออกงาน' };
var STATUS_LABEL_ = { INSIDE: 'ในพื้นที่', OUTSIDE: 'นอกพื้นที่', NO_SITE: 'ไม่ได้กำหนดพื้นที่', NO_LOCATION: 'ไม่มีตำแหน่ง' };
var CHALLENGE_TTL_ = 180;
var CODE_ALPHABET_ = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* =========================================================
 * เว็บแอป
 * ========================================================= */

function doGet(e) {
  // ตรวจว่า API ทำงาน: เปิด <URL ของเว็บแอป>?fn=config
  if (e && e.parameter && e.parameter.fn === 'config') return jsonOut_(apiDispatch_('config', []));
  var s = getSettings_();
  var t = HtmlService.createTemplateFromFile('Index');
  t.boot = jsonForScript_(publicConfig_(s));
  return t.evaluate()
    .setTitle(s.COMPANY_NAME + ' – ลงเวลา')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* =========================================================
 * JSON API สำหรับหน้าเว็บที่โฮสต์นอก Apps Script (เช่น GitHub Pages)
 *
 * ทำไมต้องมี: Apps Script แสดงหน้าเว็บใน iframe ที่ Google ไม่เปิดสิทธิ์ WebAuthn
 * (permissions policy) จึงสแกนลายนิ้วมือในหน้านั้นไม่ได้ ต้องให้หน้าเว็บเปิดเป็นหน้าหลักของเบราว์เซอร์
 * หน้าเว็บส่ง POST (Content-Type: text/plain เพื่อไม่ให้เกิด CORS preflight) เนื้อหา {"fn":"...","args":[...]}
 * ========================================================= */

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = apiDispatch_(String(body.fn || ''), Array.isArray(body.args) ? body.args : []);
  } catch (ex) {
    out = err_('BAD_REQUEST', 'คำขอไม่ถูกต้อง');
  }
  return jsonOut_(out);
}

function apiDispatch_(fn, args) {
  switch (fn) {
    case 'config':             return { ok: true, config: publicConfig_(getSettings_()) };
    case 'beginAuth':          return beginAuth();
    case 'beginRegistration':  return beginRegistration(args[0], args[1]);
    case 'finishRegistration': return finishRegistration(args[0]);
    case 'submitAttendance':   return submitAttendance(args[0]);
    default:                   return err_('UNKNOWN_FN', 'ไม่รู้จักคำสั่ง');
  }
}

function jsonOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function jsonForScript_(o) {
  return JSON.stringify(o)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function publicConfig_(s) {
  return {
    company: s.COMPANY_NAME,
    requireLocation: s.REQUIRE_LOCATION,
    blockOutside: s.BLOCK_OUTSIDE,
    sites: activeSites_().map(function (x) { return { name: x.name, lat: x.lat, lng: x.lng, radius: x.radius }; }),
    version: APP_VERSION
  };
}

/* =========================================================
 * API ที่หน้าเว็บเรียกผ่าน google.script.run
 * ========================================================= */

/** ขอ challenge สำหรับสแกนลงเวลา */
function beginAuth() {
  try {
    return { ok: true, challenge: issueChallenge_('auth') };
  } catch (e) { return fail_(e); }
}

/** ขั้นแรกของการลงทะเบียน: ตรวจรหัส แล้วส่งข้อมูลให้ navigator.credentials.create */
function beginRegistration(employeeId, code) {
  try {
    var s = getSettings_();
    var id = normId_(employeeId), c = normCode_(code);
    if (!id || !c) return err_('MISSING_FIELDS', 'กรอกรหัสพนักงานและรหัสลงทะเบียนให้ครบ');
    var chk = checkRegCode_(id, c);
    if (!chk.ok) return chk;
    var devices = activeDevicesOf_(id);
    if (devices.length >= s.MAX_DEVICES) {
      return err_('TOO_MANY_DEVICES', 'ลงทะเบียนครบ ' + s.MAX_DEVICES + ' เครื่องแล้ว ให้แอดมินปิดเครื่องเก่าที่ไม่ใช้ในแผ่นงาน "อุปกรณ์ลายนิ้วมือ"');
    }
    return {
      ok: true,
      challenge: issueChallenge_('reg:' + id),
      user: { id: b64uEncode_(utf8Encode_(id)), name: id, displayName: chk.emp.name },
      excludeIds: devices.map(function (d) { return String(d.credId); }),
      rpName: s.COMPANY_NAME
    };
  } catch (e) { return fail_(e); }
}

/** ขั้นสุดท้ายของการลงทะเบียน: ตรวจผล แล้วบันทึกอุปกรณ์ */
function finishRegistration(p) {
  try {
    p = p || {};
    var id = normId_(p.employeeId), c = normCode_(p.code);
    var chk = checkRegCode_(id, c);
    if (!chk.ok) return chk;

    var chal = webauthnPeekChallenge_(p.clientDataJSON);
    if (!chal || !consumeChallenge_(chal, 'reg:' + id)) {
      return err_('CHALLENGE_EXPIRED', 'หมดเวลาลงทะเบียน กรุณาเริ่มใหม่');
    }
    var v = webauthnVerifyRegistration_({
      expectedChallenge: chal,
      rpId: String(p.rpId || ''),
      id: String(p.id || ''),
      clientDataJSON: p.clientDataJSON,
      authenticatorData: p.authenticatorData,
      publicKey: p.publicKey
    });
    if (!v.ok) return err_(v.code, verifyMessage_(v.code));

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      if (findDevice_(p.id)) return err_('DUPLICATE_DEVICE', 'อุปกรณ์นี้ลงทะเบียนไว้แล้ว');
      var now = new Date();
      dbAppend_('devices', {
        credId: String(p.id), empId: id, publicKey: String(p.publicKey), alg: v.alg,
        rpId: v.rpId, origin: v.origin, signCount: v.signCount,
        device: String(p.deviceName || '').slice(0, 120), createdAt: now, lastUsedAt: '', active: true
      });
      dbUpdate_('employees', chk.emp._row, { regCode: '', regExpires: '' });
    } finally {
      lock.releaseLock();
    }
    clearFails_(id);
    return { ok: true, name: chk.emp.name, employeeId: id };
  } catch (e) { return fail_(e); }
}

/** ลงเวลา: ตรวจลายนิ้วมือ + ตำแหน่ง แล้วบันทึก */
function submitAttendance(p) {
  try {
    p = p || {};
    var s = getSettings_();

    var chal = webauthnPeekChallenge_(p.clientDataJSON);
    if (!chal || !consumeChallenge_(chal, 'auth')) {
      return err_('CHALLENGE_EXPIRED', 'หมดเวลาสแกน กรุณาแตะสแกนอีกครั้ง');
    }
    var dev = findDevice_(String(p.id || ''));
    if (!dev || !isActive_(dev.active)) {
      return err_('UNKNOWN_DEVICE', 'ยังไม่พบอุปกรณ์นี้ในระบบ ให้ลงทะเบียนลายนิ้วมือก่อน');
    }
    var v = webauthnVerifyAssertion_({
      cred: { publicKey: String(dev.publicKey), rpId: String(dev.rpId), origin: String(dev.origin), signCount: Number(dev.signCount) || 0 },
      expectedChallenge: chal,
      clientDataJSON: p.clientDataJSON,
      authenticatorData: p.authenticatorData,
      signature: p.signature
    });
    if (!v.ok) return err_(v.code, verifyMessage_(v.code));

    var emp = findEmployee_(dev.empId);
    if (!emp || !isActive_(emp.active)) {
      return err_('EMPLOYEE_INACTIVE', 'บัญชีพนักงานนี้ถูกปิดใช้งาน ติดต่อแอดมิน');
    }

    var geo = sanitizeGeo_(p.geo);
    if (!geo && s.REQUIRE_LOCATION) {
      return err_('NO_LOCATION', 'ยังไม่ได้ตำแหน่ง GPS เปิดตำแหน่งในเบราว์เซอร์แล้วลองใหม่');
    }
    var loc = evaluateLocation_(geo, activeSites_());
    if (s.BLOCK_OUTSIDE && loc.status === 'OUTSIDE') {
      return err_('OUTSIDE', 'คุณอยู่ห่างจาก ' + loc.site.name + ' ' + formatDistance_(loc.distance) +
        ' (อนุญาตภายใน ' + formatDistance_(loc.site.radius) + ')');
    }
    var address = (geo && s.REVERSE_GEOCODE) ? reverseGeocode_(geo.lat, geo.lng) : '';

    var mode = (p.mode === TYPE_IN || p.mode === TYPE_OUT) ? p.mode : 'AUTO';
    var now = new Date();
    var result;
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var empId = normId_(emp.id);
      var mine = dbTail_('log', 800).filter(function (r) { return normId_(r.empId) === empId && r.ts instanceof Date; });
      var last = mine.length ? mine[mine.length - 1] : null;

      dbUpdate_('devices', dev._row, { signCount: v.signCount, lastUsedAt: now });

      if (last && (now - last.ts) < s.DUPLICATE_SECONDS * 1000) {
        result = buildResult_(last, mine, true, null);
      } else {
        var type = mode;
        if (mode === 'AUTO') {
          type = (last && last.type === TYPE_LABEL_.IN && (now - last.ts) < s.AUTO_WINDOW_HOURS * 3600000) ? TYPE_OUT : TYPE_IN;
        }
        var duration = null;
        if (type === TYPE_OUT && last && last.type === TYPE_LABEL_.IN && (now - last.ts) < 24 * 3600000) {
          duration = now - last.ts;
        }
        var row = {
          ts: now, date: dateText_(now), time: Utilities.formatDate(now, tz_(), 'HH:mm:ss'),
          empId: empId, name: emp.name, type: TYPE_LABEL_[type],
          lat: geo ? geo.lat : '', lng: geo ? geo.lng : '', accuracy: geo ? Math.round(geo.accuracy) : '',
          address: address, site: loc.site ? loc.site.name : '', distance: loc.distance === undefined ? '' : loc.distance,
          status: STATUS_LABEL_[loc.status], mapUrl: geo ? mapUrl_(geo.lat, geo.lng) : '',
          device: String(p.device || '').slice(0, 120)
        };
        row._row = dbAppend_('log', row);
        mine.push(row);
        result = buildResult_(row, mine, false, duration);
      }
    } finally {
      lock.releaseLock();
    }
    return result;
  } catch (e) { return fail_(e); }
}

/* =========================================================
 * เมนูและฟังก์ชันสำหรับแอดมิน (รันจากเมนูใน Sheet หรือจากตัวแก้ไขสคริปต์)
 * ========================================================= */

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('ลงเวลา')
      .addItem('ตั้งค่าระบบ / สร้างแผ่นงาน', 'setup')
      .addItem('สร้างรหัสลงทะเบียนให้พนักงานที่ยังไม่มีอุปกรณ์', 'generateRegistrationCodes')
      .addItem('ใส่ข้อมูลตัวอย่าง', 'loadSampleData')
      .addItem('ลบข้อมูลตัวอย่าง', 'clearSampleData')
      .addToUi();
  } catch (e) { /* สคริปต์ไม่ได้ผูกกับ Sheet */ }
}

/** รันครั้งแรกครั้งเดียว: สร้าง Sheet และแผ่นงานทั้งหมด แล้วพิมพ์ลิงก์ใน Logs */
function setup() {
  ensureSchema_(true);
  var buttons = '';
  try { installButtons(); } catch (e) { buttons = '\n(ติดตั้งปุ่มสร้างรหัสไม่สำเร็จ: ' + e + ')'; }
  var msg = 'พร้อมใช้งานแล้ว\nSheet: ' + ss_().getUrl() + buttons;
  try { msg += '\nเว็บแอป (หลัง Deploy): ' + ScriptApp.getService().getUrl(); } catch (e) { /* ยังไม่ได้ deploy */ }
  console.log(msg);
  uiAlert_(msg);
  return ss_().getUrl();
}

/** สร้างรหัสลงทะเบียนให้พนักงานที่ใช้งานอยู่ แต่ยังไม่มีอุปกรณ์และยังไม่มีรหัสที่ใช้ได้ */
function generateRegistrationCodes() {
  var r = issueCodesForNeedy_();
  var msg = r.count ? ('สร้างรหัสให้ ' + r.count + ' คน (ดูในแผ่นงาน "พนักงาน"):\n' + r.lines.join('\n')) : 'ไม่มีพนักงานที่ต้องสร้างรหัสเพิ่ม';
  console.log(msg);
  uiAlert_(msg);
  return r.count;
}

function issueCodesForNeedy_() {
  var s = getSettings_();
  var devs = dbAll_('devices');
  var lines = [];
  dbAll_('employees').forEach(function (e) {
    var id = normId_(e.id);
    if (!id || !isActive_(e.active)) return;
    var hasDevice = devs.some(function (d) { return normId_(d.empId) === id && isActive_(d.active); });
    var hasValid = String(e.regCode || '') !== '' && (!(e.regExpires instanceof Date) || e.regExpires > new Date());
    if (hasDevice || hasValid) return;
    var code = makeRegCode_();
    dbUpdate_('employees', e._row, { regCode: code, regExpires: new Date(Date.now() + s.CODE_VALID_HOURS * 3600000) });
    lines.push(id + '  ' + e.name + '  ' + code);
  });
  return { count: lines.length, lines: lines };
}

/** สร้างรหัสใหม่ให้พนักงานแถวเดียว (เช่น เปลี่ยนมือถือ / เพิ่มเครื่องที่สอง) ไม่สนว่ามีอุปกรณ์อยู่แล้วหรือไม่ */
function issueCodeForRow_(rowNum) {
  var s = getSettings_();
  var e = dbAll_('employees').filter(function (x) { return x._row === rowNum; })[0];
  if (!e || !normId_(e.id)) return { ok: false, message: 'แถวนี้ยังไม่มีรหัสพนักงาน' };
  if (!isActive_(e.active)) return { ok: false, message: normId_(e.id) + ' ถูกปิดใช้งานอยู่ แก้คอลัมน์ ใช้งาน ก่อน' };
  var code = makeRegCode_();
  dbUpdate_('employees', rowNum, { regCode: code, regExpires: new Date(Date.now() + s.CODE_VALID_HOURS * 3600000) });
  return { ok: true, id: normId_(e.id), name: e.name, code: code };
}

/** ทดสอบว่า Apps Script รองรับ BigInt/SHA-256 และตรวจลายเซ็นได้ ใช้เวลาเท่าไร (รันจากตัวแก้ไข ดูผลใน Logs) */
function selfTest() {
  var t0 = Date.now();
  var r = webauthnVerifyAssertion_(SELF_TEST_VECTOR_());
  var ms = Date.now() - t0;
  console.log('selfTest ตรวจลายเซ็นถูกต้อง: ' + (r.ok === true) + ' ใช้เวลา ' + ms + ' ms');
  var bad = SELF_TEST_VECTOR_();
  bad.expectedChallenge = 'tampered';
  var r2 = webauthnVerifyAssertion_(bad);
  console.log('selfTest ปฏิเสธข้อมูลที่ถูกแก้: ' + (r2.ok === false));
  if (!(r.ok === true && r2.ok === false)) throw new Error('selfTest ไม่ผ่าน');
  return 'OK ' + ms + ' ms';
}

/* =========================================================
 * ตำแหน่ง
 * ========================================================= */

function sanitizeGeo_(g) {
  if (!g) return null;
  var lat = Number(g.lat), lng = Number(g.lng), acc = Number(g.accuracy);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat: lat, lng: lng, accuracy: isFinite(acc) && acc >= 0 ? Math.min(acc, 99999) : 0 };
}

function activeSites_() {
  return dbAll_('sites').map(function (r) {
    return { name: String(r.name), lat: Number(r.lat), lng: Number(r.lng), radius: Number(r.radius) || 100, active: isActive_(r.active) };
  }).filter(function (x) { return x.active && isFinite(x.lat) && isFinite(x.lng) && x.name; });
}

function evaluateLocation_(geo, sites) {
  if (!geo) return { status: 'NO_LOCATION' };
  if (!sites.length) return { status: 'NO_SITE' };
  var best = null, bestD = Infinity;
  sites.forEach(function (st) {
    var d = haversine_(geo.lat, geo.lng, st.lat, st.lng);
    if (d < bestD) { bestD = d; best = st; }
  });
  return { status: bestD <= best.radius ? 'INSIDE' : 'OUTSIDE', site: best, distance: Math.round(bestD) };
}

function haversine_(lat1, lng1, lat2, lng2) {
  var R = 6371008.8, rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance_(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + ' กม.' : Math.round(m) + ' ม.';
}

function mapUrl_(lat, lng) {
  return 'https://www.google.com/maps?q=' + lat.toFixed(6) + ',' + lng.toFixed(6);
}

function reverseGeocode_(lat, lng) {
  var key = 'geo:' + lat.toFixed(4) + ',' + lng.toFixed(4);
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit !== null) return hit === '-' ? '' : hit;
  var addr = '';
  try {
    var r = Maps.newGeocoder().setLanguage('th').reverseGeocode(lat, lng);
    if (r && r.status === 'OK' && r.results && r.results.length) addr = r.results[0].formatted_address || '';
  } catch (e) {
    console.warn('reverse geocode failed: ' + e);
  }
  cache.put(key, addr || '-', 21600);
  return addr;
}

/* =========================================================
 * ผลลัพธ์ที่ส่งกลับหน้าเว็บ
 * ========================================================= */

function buildResult_(row, mine, duplicate, durationMs) {
  var typeKey = row.type === TYPE_LABEL_.OUT ? TYPE_OUT : TYPE_IN;
  var status = Object.keys(STATUS_LABEL_).filter(function (k) { return STATUS_LABEL_[k] === row.status; })[0] || 'NO_SITE';
  var recent = mine.slice(-7).reverse().map(function (r) {
    return {
      type: r.type === TYPE_LABEL_.OUT ? TYPE_OUT : TYPE_IN,
      date: thaiDateShort_(r.ts),
      time: Utilities.formatDate(r.ts, tz_(), 'HH:mm'),
      site: String(r.site || ''),
      inside: r.status === STATUS_LABEL_.INSIDE
    };
  });
  return {
    ok: true,
    duplicate: !!duplicate,
    type: typeKey,
    typeLabel: TYPE_LABEL_[typeKey],
    name: row.name,
    employeeId: normId_(row.empId),
    time: Utilities.formatDate(row.ts, tz_(), 'HH:mm'),
    seconds: Utilities.formatDate(row.ts, tz_(), 'ss'),
    dateLabel: thaiDateLong_(row.ts),
    site: String(row.site || ''),
    status: status,
    statusLabel: row.status,
    distance: row.distance === '' ? null : Number(row.distance),
    accuracy: row.accuracy === '' ? null : Number(row.accuracy),
    address: String(row.address || ''),
    mapUrl: String(row.mapUrl || ''),
    durationLabel: durationMs ? durationLabel_(durationMs) : '',
    recent: recent
  };
}

function durationLabel_(ms) {
  var mins = Math.round(ms / 60000), h = Math.floor(mins / 60), m = mins % 60;
  return h ? (h + ' ชม. ' + (m ? m + ' นาที' : '')).trim() : m + ' นาที';
}

var TH_DAYS_ = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
var TH_MONTHS_ = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function tz_() { return Session.getScriptTimeZone(); }

function dateParts_(d) {
  var p = Utilities.formatDate(d, tz_(), 'u-d-M-yyyy').split('-').map(Number);
  return { dow: p[0] % 7, day: p[1], month: p[2], year: p[3] + 543 };
}
function thaiDateLong_(d) { var p = dateParts_(d); return 'วัน' + TH_DAYS_[p.dow] + 'ที่ ' + p.day + ' ' + TH_MONTHS_[p.month - 1] + ' ' + p.year; }
function thaiDateShort_(d) { var p = dateParts_(d); return p.day + ' ' + TH_MONTHS_[p.month - 1]; }
function dateText_(d) { return Utilities.formatDate(d, tz_(), 'dd/MM/yyyy'); }

/* =========================================================
 * ความปลอดภัย / ตัวช่วย
 * ========================================================= */

function sha256Bytes_(u8) {
  var arr = Array.prototype.slice.call(u8).map(function (b) { return b > 127 ? b - 256 : b; });
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, arr);
  var out = new Uint8Array(d.length);
  for (var i = 0; i < d.length; i++) out[i] = d[i] & 255;
  return out;
}

/** ไบต์สุ่มจาก UUID v4 (SecureRandom) ตัดตำแหน่ง version/variant ออก */
function randomBytes_(n) {
  var hex = '';
  while (hex.length < n * 2) {
    var u = Utilities.getUuid().replace(/-/g, '');
    hex += u.slice(0, 12) + u.slice(13, 16) + u.slice(17);
  }
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function makeRegCode_() {
  var b = randomBytes_(8), s = '';
  for (var i = 0; i < 8; i++) s += CODE_ALPHABET_[b[i] % 32];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function issueChallenge_(purpose) {
  var ch = b64uEncode_(randomBytes_(32));
  CacheService.getScriptCache().put('ch:' + ch, purpose, CHALLENGE_TTL_);
  return ch;
}

function consumeChallenge_(ch, purpose) {
  var cache = CacheService.getScriptCache();
  var got = cache.get('ch:' + ch);
  if (got !== purpose) return false;
  cache.remove('ch:' + ch);
  return true;
}

function normId_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); }
function normCode_(v) { return String(v === undefined || v === null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function findEmployee_(id) {
  id = normId_(id);
  var all = dbAll_('employees');
  for (var i = 0; i < all.length; i++) if (normId_(all[i].id) === id) return all[i];
  return null;
}

function findDevice_(credId) {
  credId = String(credId || '');
  if (!credId) return null;
  var all = dbAll_('devices');
  for (var i = 0; i < all.length; i++) if (String(all[i].credId) === credId) return all[i];
  return null;
}

function activeDevicesOf_(empId) {
  empId = normId_(empId);
  return dbAll_('devices').filter(function (d) { return normId_(d.empId) === empId && isActive_(d.active); });
}

/** ตรวจรหัสลงทะเบียน (จำกัดการเดา 5 ครั้งต่อ 15 นาทีต่อรหัสพนักงาน) */
function checkRegCode_(id, code) {
  var cache = CacheService.getScriptCache(), key = 'regfail:' + id;
  if (Number(cache.get(key) || 0) >= 5) {
    return err_('LOCKED', 'ใส่รหัสผิดหลายครั้ง รอ 15 นาทีแล้วลองใหม่ หรือติดต่อแอดมิน');
  }
  var emp = id ? findEmployee_(id) : null;
  var valid = emp && isActive_(emp.active) && code && normCode_(emp.regCode) === code;
  if (!valid) {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), 900);
    return err_('INVALID_CODE', 'รหัสพนักงานหรือรหัสลงทะเบียนไม่ถูกต้อง');
  }
  if (emp.regExpires instanceof Date && emp.regExpires < new Date()) {
    return err_('CODE_EXPIRED', 'รหัสลงทะเบียนหมดอายุ ขอรหัสใหม่จากแอดมิน');
  }
  return { ok: true, emp: emp };
}

function clearFails_(id) { CacheService.getScriptCache().remove('regfail:' + id); }

function verifyMessage_(code) {
  switch (code) {
    case 'BAD_ORIGIN':
    case 'BAD_RPID': return 'ที่อยู่เว็บของแอปไม่ตรงกับตอนลงทะเบียน (ลิงก์หรือบัญชี Google ที่ใช้เปิดเปลี่ยนไป) ให้ลงทะเบียนลายนิ้วมือใหม่ในลิงก์นี้';
    case 'BAD_SIGNATURE': return 'ยืนยันลายนิ้วมือไม่สำเร็จ ลองสแกนอีกครั้ง';
    case 'COUNTER_REPLAY': return 'ตรวจพบข้อมูลสแกนซ้ำ ลองสแกนอีกครั้ง ถ้ายังเป็นอยู่ให้แจ้งแอดมิน';
    case 'NO_UV': return 'อุปกรณ์ไม่ได้ยืนยันตัวตนด้วยลายนิ้วมือหรือล็อกหน้าจอ เปิดล็อกหน้าจอในเครื่องก่อน';
    case 'BAD_CHALLENGE': return 'หมดเวลาสแกน กรุณาลองอีกครั้ง';
    default: return 'ยืนยันตัวตนไม่สำเร็จ (' + code + ')';
  }
}

function err_(code, message) { return { ok: false, code: code, message: message }; }

function fail_(e) {
  console.error(e && e.stack ? e.stack : e);
  return err_('SERVER_ERROR', 'ระบบขัดข้อง ลองอีกครั้ง ถ้ายังไม่หายให้แจ้งแอดมิน');
}

function uiAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* ไม่มี UI */ }
}
