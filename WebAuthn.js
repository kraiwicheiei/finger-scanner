/**
 * WebAuthn.js
 * ตรวจสอบผลสแกนลายนิ้วมือ (Passkey / WebAuthn) ฝั่งเซิร์ฟเวอร์
 *
 * ไฟล์นี้เป็นฟังก์ชันล้วน ไม่แตะ Sheet/Cache เลย
 * ต้องมี sha256Bytes_(Uint8Array) -> Uint8Array ประกาศไว้ใน Code.js
 *
 * รองรับ ES256 (ECDSA P-256) และ RS256 (RSASSA-PKCS1-v1_5 / SHA-256)
 * ใช้ BigInt ล้วน ไม่พึ่งไลบรารีภายนอก
 */

/* ---------- base64url / utf8 / bytes ---------- */

var B64URL_CHARS_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
var B64URL_LOOKUP_ = null;

function b64uEncode_(bytes) {
  var C = B64URL_CHARS_, out = '', i = 0, n;
  for (; i + 2 < bytes.length; i += 3) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += C[(n >> 18) & 63] + C[(n >> 12) & 63] + C[(n >> 6) & 63] + C[n & 63];
  }
  var rem = bytes.length - i;
  if (rem === 1) {
    n = bytes[i] << 16;
    out += C[(n >> 18) & 63] + C[(n >> 12) & 63];
  } else if (rem === 2) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += C[(n >> 18) & 63] + C[(n >> 12) & 63] + C[(n >> 6) & 63];
  }
  return out;
}

function b64uDecode_(str) {
  if (!B64URL_LOOKUP_) {
    B64URL_LOOKUP_ = {};
    for (var k = 0; k < 64; k++) B64URL_LOOKUP_[B64URL_CHARS_[k]] = k;
    B64URL_LOOKUP_['+'] = 62;
    B64URL_LOOKUP_['/'] = 63;
  }
  var s = String(str || '').replace(/[=\s]/g, '');
  var out = new Uint8Array(Math.floor(s.length * 6 / 8));
  var acc = 0, bits = 0, o = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64URL_LOOKUP_[s[i]];
    if (v === undefined) throw new Error('BAD_BASE64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function utf8Encode_(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function utf8Decode_(b) {
  var s = '', i = 0;
  while (i < b.length) {
    var c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 0xf0) {
      s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    } else {
      var cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
  }
  return s;
}

function concatBytes_() {
  var total = 0, i, j;
  for (i = 0; i < arguments.length; i++) total += arguments[i].length;
  var out = new Uint8Array(total), o = 0;
  for (i = 0; i < arguments.length; i++) {
    for (j = 0; j < arguments[i].length; j++) out[o++] = arguments[i][j];
  }
  return out;
}

function bytesEq_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function bytesToHex_(b) {
  var h = '';
  for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return h;
}

function bytesToBig_(b) {
  var h = bytesToHex_(b);
  return h ? BigInt('0x' + h) : BigInt(0);
}

function bigToBytes_(n, len) {
  var h = n.toString(16);
  if (h.length > len * 2) return null;
  while (h.length < len * 2) h = '0' + h;
  var out = new Uint8Array(len);
  for (var i = 0; i < len; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/* ---------- DER ---------- */

function derTlv_(b, pos) {
  if (pos + 2 > b.length) throw new Error('DER_TRUNCATED');
  var tag = b[pos], len = b[pos + 1], p = pos + 2;
  if (len & 0x80) {
    var nb = len & 0x7f;
    if (nb < 1 || nb > 3 || p + nb > b.length) throw new Error('DER_BAD_LENGTH');
    len = 0;
    for (var k = 0; k < nb; k++) len = (len * 256) + b[p++];
  }
  if (p + len > b.length) throw new Error('DER_TRUNCATED');
  return { tag: tag, start: p, end: p + len };
}

function derChildren_(b, tlv) {
  var out = [], pos = tlv.start;
  while (pos < tlv.end) {
    var c = derTlv_(b, pos);
    out.push(c);
    pos = c.end;
  }
  return out;
}

/** อ่าน SubjectPublicKeyInfo -> {type:'EC', x, y} | {type:'RSA', n, e} (BigInt) */
function parseSpki_(spki) {
  var top = derTlv_(spki, 0);
  if (top.tag !== 0x30) throw new Error('BAD_SPKI');
  var kids = derChildren_(spki, top);
  if (kids.length < 2) throw new Error('BAD_SPKI');
  var alg = derChildren_(spki, kids[0]);
  var oid = bytesToHex_(spki.subarray(alg[0].start, alg[0].end));
  var bits = spki.subarray(kids[1].start + 1, kids[1].end); // ข้าม unused-bits byte
  if (oid === '2a8648ce3d0201') {
    var curve = alg[1] ? bytesToHex_(spki.subarray(alg[1].start, alg[1].end)) : '';
    if (curve !== '2a8648ce3d030107') throw new Error('UNSUPPORTED_CURVE');
    if (bits.length !== 65 || bits[0] !== 4) throw new Error('BAD_EC_POINT');
    return { type: 'EC', x: bytesToBig_(bits.subarray(1, 33)), y: bytesToBig_(bits.subarray(33, 65)) };
  }
  if (oid === '2a864886f70d010101') {
    var seq = derTlv_(bits, 0);
    var ints = derChildren_(bits, seq);
    if (ints.length < 2) throw new Error('BAD_RSA_KEY');
    return {
      type: 'RSA',
      n: bytesToBig_(bits.subarray(ints[0].start, ints[0].end)),
      e: bytesToBig_(bits.subarray(ints[1].start, ints[1].end))
    };
  }
  throw new Error('UNSUPPORTED_KEY');
}

function parseEcdsaSigDer_(sig) {
  var top = derTlv_(sig, 0);
  if (top.tag !== 0x30) throw new Error('BAD_SIG');
  var ints = derChildren_(sig, top);
  if (ints.length !== 2 || ints[0].tag !== 2 || ints[1].tag !== 2) throw new Error('BAD_SIG');
  return {
    r: bytesToBig_(sig.subarray(ints[0].start, ints[0].end)),
    s: bytesToBig_(sig.subarray(ints[1].start, ints[1].end))
  };
}

/* ---------- ECDSA P-256 ---------- */

var EC_ = null;
function ec_() {
  if (EC_) return EC_;
  var B = BigInt;
  EC_ = {
    p: B('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: B('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    b: B('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'),
    gx: B('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    gy: B('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
    z: B(0), one: B(1), two: B(2), three: B(3), four: B(4), eight: B(8)
  };
  return EC_;
}

function modInv_(a, m) {
  var zero = BigInt(0), one = BigInt(1);
  var r0 = m, r1 = ((a % m) + m) % m, t0 = zero, t1 = one;
  while (r1 !== zero) {
    var q = r0 / r1, tmp = r0 - q * r1;
    r0 = r1; r1 = tmp;
    tmp = t0 - q * t1; t0 = t1; t1 = tmp;
  }
  if (r0 !== one) throw new Error('NO_INVERSE');
  return ((t0 % m) + m) % m;
}

function modPow_(base, exp, mod) {
  var one = BigInt(1), zero = BigInt(0), r = one;
  base = ((base % mod) + mod) % mod;
  while (exp > zero) {
    if (exp & one) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= one;
  }
  return r;
}

function ecMod_(x) {
  var p = ec_().p;
  x = x % p;
  return x < ec_().z ? x + p : x;
}

function ecDouble_(P) {
  var E = ec_();
  if (!P || P[1] === E.z) return null;
  var X = P[0], Y = P[1], Z = P[2];
  var delta = ecMod_(Z * Z), gamma = ecMod_(Y * Y), beta = ecMod_(X * gamma);
  var alpha = ecMod_(E.three * (X - delta) * (X + delta));
  var X3 = ecMod_(alpha * alpha - E.eight * beta);
  var Z3 = ecMod_((Y + Z) * (Y + Z) - gamma - delta);
  var Y3 = ecMod_(alpha * (E.four * beta - X3) - E.eight * gamma * gamma);
  return [X3, Y3, Z3];
}

function ecAdd_(P, Q) {
  var E = ec_();
  if (!P) return Q;
  if (!Q) return P;
  var Z1Z1 = ecMod_(P[2] * P[2]), Z2Z2 = ecMod_(Q[2] * Q[2]);
  var U1 = ecMod_(P[0] * Z2Z2), U2 = ecMod_(Q[0] * Z1Z1);
  var S1 = ecMod_(P[1] * Q[2] * Z2Z2), S2 = ecMod_(Q[1] * P[2] * Z1Z1);
  var H = ecMod_(U2 - U1), R = ecMod_(S2 - S1);
  if (H === E.z) return R === E.z ? ecDouble_(P) : null;
  var HH = ecMod_(H * H), HHH = ecMod_(H * HH), V = ecMod_(U1 * HH);
  var X3 = ecMod_(R * R - HHH - E.two * V);
  var Y3 = ecMod_(R * (V - X3) - S1 * HHH);
  var Z3 = ecMod_(P[2] * Q[2] * H);
  return [X3, Y3, Z3];
}

function ecOnCurve_(x, y) {
  var E = ec_();
  if (x < E.z || x >= E.p || y < E.z || y >= E.p) return false;
  return ecMod_(y * y - (x * x * x - E.three * x + E.b)) === E.z;
}

function ecdsaVerifyP256_(qx, qy, hash32, r, s) {
  var E = ec_();
  if (r <= E.z || r >= E.n || s <= E.z || s >= E.n) return false;
  if (!ecOnCurve_(qx, qy)) return false;
  var e = bytesToBig_(hash32);
  var w = modInv_(s, E.n);
  var u1 = (e * w) % E.n, u2 = (r * w) % E.n;
  var G = [E.gx, E.gy, E.one], Q = [qx, qy, E.one], GQ = ecAdd_(G, Q);
  var R = null;
  for (var i = 255; i >= 0; i--) {
    R = ecDouble_(R);
    var b1 = (u1 >> BigInt(i)) & E.one, b2 = (u2 >> BigInt(i)) & E.one;
    if (b1 === E.one && b2 === E.one) R = ecAdd_(R, GQ);
    else if (b1 === E.one) R = ecAdd_(R, G);
    else if (b2 === E.one) R = ecAdd_(R, Q);
  }
  if (!R) return false;
  var zinv = modInv_(R[2], E.p);
  var x = ecMod_(R[0] * zinv * zinv);
  return (x % E.n) === r;
}

/* ---------- RSASSA-PKCS1-v1_5 / SHA-256 ---------- */

var SHA256_DIGESTINFO_ = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,
  0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

function rsaVerifySha256_(n, e, sig, hash32) {
  var k = Math.ceil(n.toString(16).length / 2);
  if (sig.length !== k) return false;
  var s = bytesToBig_(sig);
  if (s >= n) return false;
  var em = bigToBytes_(modPow_(s, e, n), k);
  if (!em) return false;
  var t = concatBytes_(new Uint8Array(SHA256_DIGESTINFO_), hash32);
  var padLen = k - 3 - t.length;
  if (padLen < 8) return false;
  var expected = new Uint8Array(k);
  expected[1] = 1;
  for (var i = 0; i < padLen; i++) expected[2 + i] = 0xff;
  for (var j = 0; j < t.length; j++) expected[3 + padLen + j] = t[j];
  return bytesEq_(em, expected);
}

/* ---------- authenticator data / client data ---------- */

function parseAuthData_(ad) {
  if (ad.length < 37) return null;
  var flags = ad[32];
  var o = {
    rpIdHash: ad.subarray(0, 32),
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
    at: !!(flags & 0x40),
    signCount: ad[33] * 16777216 + ad[34] * 65536 + ad[35] * 256 + ad[36]
  };
  if (o.at) {
    if (ad.length < 55) return null;
    var idLen = (ad[53] << 8) | ad[54];
    if (ad.length < 55 + idLen) return null;
    o.credentialId = ad.subarray(55, 55 + idLen);
  }
  return o;
}

function parseClientData_(bytes) {
  try {
    var cd = JSON.parse(utf8Decode_(bytes));
    return (cd && typeof cd === 'object') ? cd : null;
  } catch (e) {
    return null;
  }
}

function originHost_(origin) {
  var m = /^https?:\/\/([^\/:]+)(?::\d+)?$/i.exec(String(origin || ''));
  return m ? m[1].toLowerCase() : '';
}

function waFail_(code) { return { ok: false, code: code }; }

/** ดึง challenge ออกจาก clientDataJSON (b64url) เพื่อไปตรวจ/ใช้ทิ้งใน Cache ก่อน */
function webauthnPeekChallenge_(clientDataB64u) {
  try {
    var cd = parseClientData_(b64uDecode_(clientDataB64u));
    return cd && typeof cd.challenge === 'string' ? cd.challenge : '';
  } catch (e) {
    return '';
  }
}

/**
 * ตรวจการลงทะเบียน (navigator.credentials.create)
 * o = { expectedChallenge, rpId, id, clientDataJSON, authenticatorData, publicKey }  (ทั้งหมดเป็น b64url ยกเว้น rpId)
 */
function webauthnVerifyRegistration_(o) {
  var cdBytes, adBytes, spki;
  try {
    cdBytes = b64uDecode_(o.clientDataJSON);
    adBytes = b64uDecode_(o.authenticatorData);
    spki = b64uDecode_(o.publicKey);
  } catch (e) { return waFail_('BAD_ENCODING'); }

  var cd = parseClientData_(cdBytes);
  if (!cd) return waFail_('BAD_CLIENT_DATA');
  if (cd.type !== 'webauthn.create') return waFail_('BAD_TYPE');
  if (cd.challenge !== o.expectedChallenge) return waFail_('BAD_CHALLENGE');

  var host = originHost_(cd.origin), rpId = String(o.rpId || '').toLowerCase();
  if (!rpId || !host || !(host === rpId || host.slice(-(rpId.length + 1)) === '.' + rpId)) return waFail_('BAD_ORIGIN');

  var ad = parseAuthData_(adBytes);
  if (!ad) return waFail_('BAD_AUTH_DATA');
  if (!bytesEq_(ad.rpIdHash, sha256Bytes_(utf8Encode_(rpId)))) return waFail_('BAD_RPID');
  if (!ad.up) return waFail_('NO_UP');
  if (!ad.uv) return waFail_('NO_UV');
  if (!ad.at || !ad.credentialId) return waFail_('BAD_AUTH_DATA');
  if (b64uEncode_(ad.credentialId) !== o.id) return waFail_('BAD_CRED_ID');

  var key;
  try { key = parseSpki_(spki); } catch (e) { return waFail_('BAD_KEY'); }
  if (key.type === 'EC' && !ecOnCurve_(key.x, key.y)) return waFail_('BAD_KEY');

  return { ok: true, alg: key.type === 'EC' ? -7 : -257, signCount: ad.signCount, origin: cd.origin, rpId: rpId };
}

/**
 * ตรวจการสแกน (navigator.credentials.get)
 * o = { cred:{publicKey, rpId, origin, signCount}, expectedChallenge, clientDataJSON, authenticatorData, signature }
 */
function webauthnVerifyAssertion_(o) {
  var cdBytes, adBytes, sig, spki;
  try {
    cdBytes = b64uDecode_(o.clientDataJSON);
    adBytes = b64uDecode_(o.authenticatorData);
    sig = b64uDecode_(o.signature);
    spki = b64uDecode_(o.cred.publicKey);
  } catch (e) { return waFail_('BAD_ENCODING'); }

  var cd = parseClientData_(cdBytes);
  if (!cd) return waFail_('BAD_CLIENT_DATA');
  if (cd.type !== 'webauthn.get') return waFail_('BAD_TYPE');
  if (cd.challenge !== o.expectedChallenge) return waFail_('BAD_CHALLENGE');
  if (cd.origin !== o.cred.origin) return waFail_('BAD_ORIGIN');

  var ad = parseAuthData_(adBytes);
  if (!ad) return waFail_('BAD_AUTH_DATA');
  if (!bytesEq_(ad.rpIdHash, sha256Bytes_(utf8Encode_(String(o.cred.rpId).toLowerCase())))) return waFail_('BAD_RPID');
  if (!ad.up) return waFail_('NO_UP');
  if (!ad.uv) return waFail_('NO_UV');

  var key;
  try { key = parseSpki_(spki); } catch (e) { return waFail_('BAD_KEY'); }

  var signed = concatBytes_(adBytes, sha256Bytes_(cdBytes));
  var hash = sha256Bytes_(signed);
  var valid = false;
  try {
    if (key.type === 'EC') {
      var rs = parseEcdsaSigDer_(sig);
      valid = ecdsaVerifyP256_(key.x, key.y, hash, rs.r, rs.s);
    } else {
      valid = rsaVerifySha256_(key.n, key.e, sig, hash);
    }
  } catch (e) { valid = false; }
  if (!valid) return waFail_('BAD_SIGNATURE');

  var stored = Number(o.cred.signCount) || 0;
  if ((ad.signCount !== 0 || stored !== 0) && ad.signCount <= stored) return waFail_('COUNTER_REPLAY');

  return { ok: true, signCount: ad.signCount };
}
