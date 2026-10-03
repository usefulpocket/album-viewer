// アルバムの中身を、必要な部分だけ取り寄せて返す Service Worker（依存なし）
//
//   ./a/<sid>/<アルバムの中のパス> への要求を横取りし、manifest に書かれた位置・長さから
//   - 端末のファイル … File.slice
//   - URL         … HTTP Range（bytes=a-b。単純な範囲なので事前確認 OPTIONS は飛ばない）
//   で読んで返す。<video> の Range 要求にも 206 で答えるので、シークできる。
//
//   開けるもの
//   - ZIP    … scripts/pack.mjs で作ったもの（先頭のファイルが無圧縮の manifest.json）
//   - .album … scripts/encrypt.mjs で暗号化したもの。取り寄せた 64KB のかたまりをここで復号して返す。
//              鍵は画面から（共有 URL の # の後ろ k=）受け取り、この Service Worker のメモリにだけ置く。送らない・保存しない
'use strict';

const SCOPE = new URL(self.registration.scope);
const VIRT = SCOPE.pathname + 'a/';
const HEAD = 256 * 1024;            // 最初に読む量。manifest がこれより長ければ残りを読み足す
const HTTP_CHUNK = 4 * 1024 * 1024; // 終わりの無い Range（動画の続き）に、一度にこれだけ返す
const FORMAT = 'album-share/1';
const ENC_MAGIC = 'ALBUMENC', ENC_INFO = 'album-share-enc/1', ENC_HDR = 64, TAG = 16;

const opened = new Map(); // sid → Promise<{ src, manifest, enc? }>
const asking = new Map(); // sid → Promise（聞き直し中）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const m = e.data, port = e.ports[0];
  if (!m || m.type !== 'open' || !port) return;
  const p = openArchive(m.sid, m.src);
  e.waitUntil(p.then(
    a => port.postMessage({ ok: true, manifest: a.manifest, encrypted: !!a.enc }),
    err => port.postMessage({ ok: false, error: String((err && err.message) || err), needKey: !!(err && err.needKey) }),
  ));
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== SCOPE.origin || !u.pathname.startsWith(VIRT)) return;
  e.respondWith(serve(e.request, u, e.clientId));
});

// ---------------------------------------------------------------- 読む

async function readRange(src, start, len) {
  if (src.kind === 'file') return src.file.slice(start, start + len);
  const r = await fetch(src.url, {
    headers: { Range: `bytes=${start}-${start + len - 1}` },
    // Google の API キーを「このサイトからだけ」に絞るには送り元（オリジン）が要る。# の後ろは元々送られない
    credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin', cache: 'no-store',
  });
  if (r.status !== 206) {
    if (r.body) r.body.cancel();
    throw new Error(r.status === 200 ? '配信元が範囲指定（Range）に対応していません' : `配信元の応答が ${r.status} でした`);
  }
  return r.body;
}
const readBytes = async (src, start, len) => new Uint8Array(await new Response(await readRange(src, start, len)).arrayBuffer());

function openArchive(sid, src) {
  const p = load(src);
  opened.set(sid, p);
  p.catch(() => opened.delete(sid));
  return p;
}

async function load(src) {
  let head;
  try { head = await readBytes(src, 0, HEAD); }
  catch (err) {
    if (err instanceof TypeError) throw new Error('取り寄せられませんでした（URL・CORS・ネットワークを確認）');
    throw err;
  }
  if (head.length >= ENC_HDR && new TextDecoder().decode(head.subarray(0, 8)) === ENC_MAGIC) return loadEnc(src, head);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error('アルバムの ZIP・.album ではありません');
  const flags = dv.getUint16(6, true), method = dv.getUint16(8, true), size = dv.getUint32(18, true);
  const nlen = dv.getUint16(26, true), elen = dv.getUint16(28, true);
  const name = new TextDecoder().decode(head.subarray(30, 30 + nlen));
  if (name !== 'manifest.json' || (flags & 8)) throw new Error('先頭が manifest.json の ZIP ではありません（scripts/pack.mjs で作った ZIP を開いてください）');
  const at = 30 + nlen + elen;
  let body = head.subarray(at, at + size);
  if (body.length < size) body = await readBytes(src, at, size);
  let text;
  if (method === 0) text = new TextDecoder().decode(body);
  else if (method === 8) text = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  else throw new Error('manifest の圧縮方式に対応していません');
  return { src, manifest: checkManifest(JSON.parse(text)) };
}

function checkManifest(m) {
  if (m.format !== FORMAT) throw new Error('形式が違います: ' + m.format);
  return m;
}

// ---------------------------------------------------------------- 暗号化したアルバム（形は scripts/encrypt.mjs の頭に）

const needKey = msg => Object.assign(new Error(msg), { needKey: true });
const encLen = (n, C) => n + TAG * Math.ceil(n / C);
function ivAt(pos) { // かたまりの .album 先頭からの位置を IV の後ろ 8 バイトに
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(pos));
  return iv;
}
const openChunk = (enc, pos, ct) =>
  crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivAt(pos), additionalData: enc.aad, tagLength: 128 }, enc.key, ct);
function b64u(s) {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, c => c.charCodeAt(0));
}

async function loadEnc(src, head) {
  if (!src.k) throw needKey('暗号化されたアルバムです。鍵が要ります');
  if (head[8] !== 1) throw new Error('この暗号化の版には対応していません: ' + head[8]);
  if (head[9] < 12 || head[9] > 24) throw new Error('かたまりの大きさがおかしい（壊れている？）');
  const C = 2 ** head[9], manLen = new DataView(head.buffer, head.byteOffset).getUint32(12, true);
  let raw;
  try { raw = b64u(src.k); } catch { raw = null; }
  if (!raw || raw.length !== 32) throw needKey('鍵の形が違います（43 文字の英数字・-・_）');
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: head.slice(16, 32), info: new TextEncoder().encode(ENC_INFO) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const enc = { key, C, aad: head.slice(0, 32) };
  const mEnc = encLen(manLen, C);
  let body = head.subarray(ENC_HDR, ENC_HDR + mEnc);
  if (body.length < mEnc) body = await readBytes(src, ENC_HDR, mEnc);
  const parts = [];
  try {
    for (let q = 0; q < mEnc; q += C + TAG) {
      const ct = body.subarray(q, Math.min(mEnc, q + C + TAG));
      parts.push(new Uint8Array(await openChunk(enc, ENC_HDR + q, ct)));
    }
  } catch (err) {
    if (err && err.name === 'OperationError') throw needKey('鍵が違います（またはファイルが壊れています）');
    throw err;
  }
  const text = new TextDecoder().decode(await new Blob(parts).arrayBuffer());
  return { src, manifest: checkManifest(JSON.parse(text)), enc };
}

// ファイル（.album の off から、平文で len バイト）の [s, s+n) を返す。
// その範囲にかかるかたまりだけを 1 回で取り寄せ、届いた順に 1 つずつ復号して流す（大きい動画でもメモリを食わない）
async function decrypted(a, off, len, s, n) {
  const { C } = a.enc, CE = C + TAG;
  const c0 = Math.floor(s / C), c1 = Math.floor((s + n - 1) / C);
  const from = off + c0 * CE, to = off + c1 * CE + Math.min(C, len - c1 * C) + TAG;
  const raw = await readRange(a.src, from, to - from);
  const reader = (raw instanceof Blob ? raw.stream() : raw).getReader();
  const bufs = [];
  let have = 0, c = c0;
  async function take(need) { // ちょうど need バイト集める
    while (have < need) {
      const { done, value } = await reader.read();
      if (done) throw new Error('途中で途切れました');
      bufs.push(value); have += value.length;
    }
    const out = new Uint8Array(need);
    for (let w = 0; w < need;) {
      const b = bufs[0], k = Math.min(b.length, need - w);
      out.set(b.subarray(0, k), w); w += k;
      if (k === b.length) bufs.shift(); else bufs[0] = b.subarray(k);
    }
    have -= need;
    return out;
  }
  return new ReadableStream({
    async pull(ctl) {
      const pl = Math.min(C, len - c * C);
      const pt = new Uint8Array(await openChunk(a.enc, off + c * CE, await take(pl + TAG)));
      const i = c === c0 ? s - c * C : 0, j = Math.min(pl, s + n - c * C);
      ctl.enqueue(pt.subarray(i, j));
      if (++c > c1) { ctl.close(); reader.cancel().catch(() => {}); }
    },
    cancel() { return reader.cancel(); },
  });
}

// ---------------------------------------------------------------- Service Worker が止まって開き先を忘れたら、開いている画面に聞き直す

function archiveFor(sid, clientId) {
  if (opened.has(sid)) return opened.get(sid);
  if (!asking.has(sid)) {
    const p = askClients(sid, clientId).then(src => (src ? openArchive(sid, src) : null));
    asking.set(sid, p);
    p.finally(() => asking.delete(sid));
  }
  return asking.get(sid);
}
async function askClients(sid, clientId) {
  const one = clientId && (await self.clients.get(clientId));
  const list = one ? [one] : await self.clients.matchAll({ type: 'window' });
  for (const c of list) {
    const src = await new Promise(resolve => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), 3000);
      ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); };
      c.postMessage({ type: 'need', sid }, [ch.port2]);
    });
    if (src) return src;
  }
  return null;
}

// ---------------------------------------------------------------- 返す

const text = (status, body, headers) =>
  new Response(body, { status, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers) });

function body(a, off, len, s, n) {
  if (n === 0) return null;
  return a.enc ? decrypted(a, off, len, s, n) : readRange(a.src, off + s, n);
}

async function serve(req, u, clientId) {
  const rest = u.pathname.slice(VIRT.length);
  const cut = rest.indexOf('/');
  const sid = rest.slice(0, cut);
  const path = rest.slice(cut + 1).split('/').map(decodeURIComponent).join('/');
  try {
    const a = await archiveFor(sid, clientId);
    if (!a) return text(410, 'アルバムを開き直してください');
    const f = a.manifest.files[path];
    if (!f) return text(404, 'アルバムの中にありません: ' + path);
    const [off, len, type] = f;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const range = req.headers.get('Range');
    if (!range) {
      headers['Content-Length'] = String(len);
      return new Response(await body(a, off, len, 0, len), { status: 200, headers });
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return text(416, '', { 'Content-Range': `bytes */${len}` });
    let s, e;
    if (m[1] === '') { s = Math.max(0, len - Number(m[2])); e = len - 1; }
    else {
      s = Number(m[1]);
      e = m[2] === '' ? len - 1 : Math.min(Number(m[2]), len - 1);
      if (m[2] === '' && (a.src.kind !== 'file' || a.enc)) e = Math.min(e, s + HTTP_CHUNK - 1);
    }
    if (s >= len || s > e) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${len}` } });
    headers['Content-Length'] = String(e - s + 1);
    headers['Content-Range'] = `bytes ${s}-${e}/${len}`;
    return new Response(await body(a, off, len, s, e - s + 1), { status: 206, headers });
  } catch (err) {
    return text(502, String((err && err.message) || err));
  }
}
