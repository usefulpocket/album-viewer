// ZIP の中身を、必要な部分だけ取り寄せて返す Service Worker（依存なし）
//
//   ./a/<sid>/<ZIP の中のパス> への要求を横取りし、manifest.json に書かれた位置（ZIP 先頭からのバイト位置・長さ）から
//   - 端末のファイル … File.slice
//   - URL         … HTTP Range（bytes=a-b。単純な範囲なので事前確認 OPTIONS は飛ばない）
//   で読んで返す。<video> の Range 要求にも 206 で答えるので、シークできる。
//
//   ZIP は scripts/pack.mjs で作ったもの（先頭のファイルが無圧縮の manifest.json）に限る。
'use strict';

const SCOPE = new URL(self.registration.scope);
const VIRT = SCOPE.pathname + 'a/';
const HEAD = 256 * 1024;            // 最初に読む量。manifest がこれより長ければ残りを読み足す
const HTTP_CHUNK = 4 * 1024 * 1024; // 終わりの無い Range（動画の続き）に、URL からは一度にこれだけ返す
const FORMAT = 'album-share/1';

const opened = new Map(); // sid → Promise<{ src, manifest }>
const asking = new Map(); // sid → Promise<src|null>（聞き直し中）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const m = e.data, port = e.ports[0];
  if (!m || m.type !== 'open' || !port) return;
  const p = openArchive(m.sid, m.src);
  e.waitUntil(p.then(
    a => port.postMessage({ ok: true, manifest: a.manifest }),
    err => port.postMessage({ ok: false, error: String((err && err.message) || err) }),
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
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP ではありません');
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
  const manifest = JSON.parse(text);
  if (manifest.format !== FORMAT) throw new Error('形式が違います: ' + manifest.format);
  return { src, manifest };
}

// Service Worker が止まって開き先を忘れたら、開いている画面に聞き直す
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

async function serve(req, u, clientId) {
  const rest = u.pathname.slice(VIRT.length);
  const cut = rest.indexOf('/');
  const sid = rest.slice(0, cut);
  const path = rest.slice(cut + 1).split('/').map(decodeURIComponent).join('/');
  try {
    const a = await archiveFor(sid, clientId);
    if (!a) return text(410, 'ZIP を開き直してください');
    const f = a.manifest.files[path];
    if (!f) return text(404, 'ZIP の中にありません: ' + path);
    const [off, len, type] = f;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const range = req.headers.get('Range');
    if (!range) {
      headers['Content-Length'] = String(len);
      return new Response(await readRange(a.src, off, len), { status: 200, headers });
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return text(416, '', { 'Content-Range': `bytes */${len}` });
    let s, e;
    if (m[1] === '') { s = Math.max(0, len - Number(m[2])); e = len - 1; }
    else {
      s = Number(m[1]);
      e = m[2] === '' ? len - 1 : Math.min(Number(m[2]), len - 1);
      if (m[2] === '' && a.src.kind !== 'file') e = Math.min(e, s + HTTP_CHUNK - 1);
    }
    if (s >= len || s > e) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${len}` } });
    headers['Content-Length'] = String(e - s + 1);
    headers['Content-Range'] = `bytes ${s}-${e}/${len}`;
    return new Response(await readRange(a.src, off + s, e - s + 1), { status: 206, headers });
  } catch (err) {
    return text(502, String((err && err.message) || err));
  }
}
