// ビューア: 開き先（端末の ZIP / URL）を Service Worker に渡し、manifest を受け取って画面を作る。
// 写真・動画は Service Worker の仮想 URL（./a/<sid>/<ZIP の中のパス>）で読み込む。
//
//   開き方
//     - 「ZIP を選ぶ」かドラッグ … 端末の中のファイル。必要な部分だけ File.slice で読む
//     - #src=<URL>               … HTTP の Range で必要な部分だけ取り寄せる（# の後ろはサーバーに送られない）
//     - #drive=<ファイルID>&key=<APIキー> … Google Drive（リンクを知っている全員に公開したファイル）。未検証
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const openView = $('open'), app = $('app'), status = $('status'), input = $('file');
  let current = null; // { sid, src }

  const say = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); };

  if (!('serviceWorker' in navigator)) {
    say('このブラウザでは開けません（Service Worker が使えません）。', true);
    return;
  }

  // ---- Service Worker の用意（初回は制御が始まるまで待つ）
  const ready = (async () => {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
    return reg;
  })();

  // Service Worker は暇になると止まり、開き先を忘れる。そのとき聞き直されるので答える
  navigator.serviceWorker.onmessage = e => {
    const m = e.data;
    if (m && m.type === 'need' && e.ports[0]) e.ports[0].postMessage(current && m.sid === current.sid ? current.src : null);
  };

  function call(msg) {
    return new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => (e.data && e.data.ok ? resolve(e.data) : reject(new Error((e.data && e.data.error) || '開けませんでした')));
      navigator.serviceWorker.controller.postMessage(msg, [ch.port2]);
    });
  }

  async function open(src, label) {
    say(label + ' を開いています…');
    try {
      const reg = await ready;
      const sid = Math.random().toString(36).slice(2, 10);
      const { manifest } = await call({ type: 'open', sid, src });
      current = { sid, src };
      const base = new URL('a/' + sid + '/', reg.scope).href;
      const url = p => base + p.split('/').map(encodeURIComponent).join('/');
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = '別の ZIP を開く';
      again.addEventListener('click', () => { app.hidden = true; openView.hidden = false; say(''); input.value = ''; });
      document.title = manifest.title || 'アルバム';
      openView.hidden = true;
      app.hidden = false;
      AlbumUI.mount(app, manifest.album, url, { actions: [again] });
      say('');
    } catch (err) {
      openView.hidden = false;
      app.hidden = true;
      say(label + ' を開けませんでした。\n' + (err && err.message || err), true);
    }
  }

  // ---- 開き先
  function fromHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get('src')) {
      const u = new URL(q.get('src'), location.href);
      return { src: { kind: 'http', url: u.href }, label: u.pathname.split('/').pop() || u.host };
    }
    if (q.get('drive')) {
      if (!q.get('key')) throw new Error('#drive には key（API キー）も要ります');
      const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(q.get('drive')) +
        '?alt=media&key=' + encodeURIComponent(q.get('key'));
      return { src: { kind: 'http', url }, label: 'Google Drive のファイル' };
    }
    return null;
  }
  function fromLocation() {
    try {
      const h = fromHash();
      if (h) open(h.src, h.label);
    } catch (err) { say(err.message, true); }
  }
  addEventListener('hashchange', fromLocation);
  fromLocation();

  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) open({ kind: 'file', file: f }, f.name);
  });
  // ドラッグで開く。外（エクスプローラーなど）から持ってきたファイルだけ受け付ける。
  // ページの中の写真をつかんで落としたときは何もしない（以前は写真を ZIP として開こうとして画面が切り替わっていた）
  let inner = false;
  addEventListener('dragstart', () => { inner = true; });
  addEventListener('dragend', () => { inner = false; });
  const fromOutside = e => !inner && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragover', e => {
    e.preventDefault();
    if (fromOutside(e)) openView.classList.add('drag'); else e.dataTransfer.dropEffect = 'none';
  });
  addEventListener('dragleave', e => { if (!e.relatedTarget) openView.classList.remove('drag'); });
  addEventListener('drop', e => {
    e.preventDefault();
    openView.classList.remove('drag');
    if (!fromOutside(e)) { inner = false; return; }
    const f = e.dataTransfer.files[0];
    if (!f) return;
    // アルバムを見ている最中に ZIP 以外が落ちてきても、見ている画面は消さない
    if (!app.hidden && !/\.zip$/i.test(f.name)) return;
    open({ kind: 'file', file: f }, f.name);
  });
})();
