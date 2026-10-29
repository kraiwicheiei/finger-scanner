/**
 * Buttons.js
 * "ปุ่ม" สร้างรหัสลงทะเบียนในแผ่นงาน "พนักงาน" ใช้ช่องติ๊ก (checkbox) แทนปุ่ม
 * เพราะใช้ได้ทั้งบนคอมและแอป Google Sheets บนมือถือ และสร้างให้อัตโนมัติได้
 *
 *   ช่อง I2          ติ๊ก = สร้างรหัสให้ทุกคนที่ยังไม่มีอุปกรณ์และยังไม่มีรหัส
 *                    (ห้ามใส่ข้อมูลอื่นใต้ I2 และใต้ G ของแถวที่ไม่มีพนักงาน ไม่งั้นแถวใหม่จะถูกต่อท้ายผิดที่)
 *   คอลัมน์ G รายคน   ติ๊ก = สร้างรหัสใหม่ให้คนนั้น (เปลี่ยนมือถือ / เพิ่มเครื่อง)
 *
 * ระบบติ๊กออกให้เองหลังสร้างรหัสเสร็จ
 * ติดตั้งโดย setup() (รันซ้ำได้) ต้องมีทริกเกอร์ onEdit แบบติดตั้ง (installable trigger)
 */

var BTN_GEN_COL_ = 7;      // G
var BTN_ALL_COL_ = 9;      // I
var BTN_ALL_ROW_ = 2;

function installButtons() {
  var ss = ss_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetEdit_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetEdit_').forSpreadsheet(ss).onEdit().create();
  drawButtons_();
}

/** วาดช่องติ๊กและป้ายกำกับ (ไม่แตะข้อมูลพนักงาน) */
function drawButtons_() {
  var sh = sheet_('employees');
  sh.getRange(1, BTN_GEN_COL_).setValue('สร้างรหัสใหม่ (ติ๊ก)')
    .setFontWeight('bold').setBackground('#0F1E33').setFontColor('#FFFFFF');
  sh.setColumnWidth(BTN_GEN_COL_, 150);
  sh.getRange(1, BTN_ALL_COL_).setValue('ติ๊กช่องข้างล่าง = สร้างรหัสให้ทุกคนที่ยังไม่มีอุปกรณ์ (ติ๊กออกเอง)').setFontWeight('bold');
  sh.setColumnWidth(BTN_ALL_COL_, 440);
  sh.getRange(BTN_ALL_ROW_, BTN_ALL_COL_).insertCheckboxes();
  var last = dbAll_('employees').reduce(function (m, e) { return Math.max(m, e._row); }, 1);
  if (last >= 2) sh.getRange(2, BTN_GEN_COL_, last - 1, 1).insertCheckboxes();
}

/** ทริกเกอร์ onEdit (ติดตั้งโดย installButtons) */
function onSheetEdit_(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEETS_.employees.name) return;
    var r = e.range.getRow(), c = e.range.getColumn();
    var single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
    var ticked = single && String(e.value).toUpperCase() === 'TRUE';
    var lock = LockService.getScriptLock();

    if (ticked && c === BTN_ALL_COL_ && r === BTN_ALL_ROW_) {
      e.range.setValue(false);
      lock.waitLock(20000);
      var res;
      try { res = issueCodesForNeedy_(); } finally { lock.releaseLock(); }
      toast_(e, res.count ? ('สร้างรหัสให้ ' + res.count + ' คนแล้ว ดูในคอลัมน์ รหัสลงทะเบียน') : 'ไม่มีพนักงานที่ต้องสร้างรหัสเพิ่ม (มีอุปกรณ์หรือรหัสที่ใช้ได้อยู่แล้ว)');
      return;
    }
    if (ticked && c === BTN_GEN_COL_ && r >= 2) {
      e.range.setValue(false);
      lock.waitLock(20000);
      var one;
      try { one = issueCodeForRow_(r); } finally { lock.releaseLock(); }
      toast_(e, one.ok ? ('สร้างรหัสให้ ' + one.id + ' ' + one.name + ' แล้ว') : one.message);
      return;
    }
    // เพิ่มแถวพนักงานใหม่: เติมช่องติ๊กให้แถวนั้น
    if (c <= 2 && r >= 2) {
      var cell = sh.getRange(r, BTN_GEN_COL_);
      if (String(sh.getRange(r, 1).getValue()) !== '' && cell.getValue() === '') cell.insertCheckboxes();
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

function toast_(e, msg) {
  try { (e.source || ss_()).toast(msg, 'ลงเวลา', 8); } catch (err) { console.log(msg); }
}
