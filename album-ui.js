// アルバムの画面。ビューア（index.html）と、ZIP を解凍したときの index.html の両方で使う。依存なし
//
//   AlbumUI.mount(root, album, url, opts)
//     album  … manifest.json の album（days → scenes → items）
//     url(p) … ZIP の中のパス → 読み込む URL（ビューアは Service Worker の仮想 URL、解凍したときはそのまま）
//     opts.actions … 題名の横に並べる要素（「別の ZIP を開く」など）
(function () {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const caption = it => [it.time ? it.time + (it.est ? '（推定）' : '') : '', it.dev || ''].filter(Boolean).join(' · ') || '時刻不明';
  // 旅の記録のメモ。URL はリンクにする（ほかは文字として入れる）
  function memo(it) {
    const p = el('p', 'memo' + (it.level > 1 ? ' l2' : ''));
    if (it.time) p.append(el('span', 'mt', it.time));
    String(it.text).split(/(https?:\/\/[^\s）)]+)/).forEach((part, k) => {
      if (k % 2) { const a = el('a', null, part); a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; p.append(a); }
      else if (part) p.append(part);
    });
    return p;
  }
  const yen = n => '¥' + Number(n).toLocaleString('ja-JP');

  // 写真のピンチ拡大（2 本指）・拡大中の移動（1 本指／マウス）・ダブルタップ・ホイール。
  // 拡大したら、あれば高解像度版（zoom）に差し替える。拡大中は左右スワイプで前後へ移らない
  function pinchZoom(stage) {
    let img = null, hi = null, s = 1, tx = 0, ty = 0, pts = new Map(), g = null, lastTap = 0;
    const MAX = 6;
    function apply() {
      if (!img) return;
      // 写真の外に隙間ができないように動ける範囲を絞る
      const w = img.offsetWidth, h = img.offsetHeight;
      tx = Math.min(0, Math.max(w * (1 - s), tx)); ty = Math.min(0, Math.max(h * (1 - s), ty));
      img.style.transform = s === 1 ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
      if (s > 1.4 && hi && !img.dataset.z) { // 高解像度版へ
        img.dataset.z = '1';
        const big = new Image(), mine = img;
        big.onload = () => { if (img === mine) mine.src = big.src; };
        big.src = hi;
      }
    }
    function zoomAt(ns, cx, cy) { // 画面上の点 (cx, cy) を動かさずに倍率を変える
      const r = img.getBoundingClientRect(), bx = r.left - tx, by = r.top - ty;
      ns = Math.min(MAX, Math.max(1, ns));
      const px = (cx - bx - tx) / s, py = (cy - by - ty) / s;
      s = ns; tx = cx - bx - px * s; ty = cy - by - py * s;
      if (s === 1) { tx = 0; ty = 0; }
      apply();
    }
    const mid = () => { const a = [...pts.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; };
    function down(e) {
      if (!img || e.target !== img) return;
      img.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        // 始めたときに指の中点の下にあった写真の点を覚えておき、その点が指の中点に付いてくるようにする
        const m = mid(), r = img.getBoundingClientRect();
        g = { kind: 'pinch', d: m.d || 1, s: s, bx: r.left - tx, by: r.top - ty, px: (m.x - r.left) / s, py: (m.y - r.top) / s };
      }
      else if (pts.size === 1) g = { kind: 'pan', x: e.clientX, y: e.clientY, tx: tx, ty: ty, t: Date.now(), moved: false };
    }
    function move(e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g && g.kind === 'pinch' && pts.size >= 2) {
        const m = mid();
        s = Math.min(MAX, Math.max(1, g.s * m.d / g.d)); // 指の間の距離で倍率
        tx = m.x - g.bx - g.px * s; ty = m.y - g.by - g.py * s;
        if (s === 1) { tx = 0; ty = 0; }
        apply();
        e.preventDefault();
      } else if (g && g.kind === 'pan') {
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
        if (s > 1) { tx = g.tx + dx; ty = g.ty + dy; apply(); e.preventDefault(); }
      }
    }
    function up(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (g && g.kind === 'pan' && !g.moved && Date.now() - g.t < 300) { // ダブルタップで切り替え
        if (Date.now() - lastTap < 320) { zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY); lastTap = 0; }
        else lastTap = Date.now();
      }
      if (pts.size === 1) { const p = [...pts.values()][0]; g = { kind: 'pan', x: p.x, y: p.y, tx: tx, ty: ty, t: 0, moved: true }; }
      else if (pts.size === 0) g = null;
    }
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move, { passive: false });
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', e => { // パソコン: ホイールで拡大縮小
      if (!img || e.target !== img) return;
      e.preventDefault();
      zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    return {
      attach(el, hiSrc) { img = el; hi = hiSrc; s = 1; tx = 0; ty = 0; pts.clear(); g = null; },
      reset() { if (img) img.style.transform = ''; img = null; hi = null; s = 1; tx = 0; ty = 0; pts.clear(); g = null; },
      active() { return s > 1.01 || pts.size > 1; },
    };
  }

  function mount(root, album, url, opts) {
    opts = opts || {};
    root.textContent = '';
    const items = []; // { it, scene, a }

    // ---- 題名と日付の帯
    const header = el('header'), hd = el('div', 'hd'), tt = el('div', 'tt'), nav = el('nav');
    nav.setAttribute('aria-label', '日付');
    tt.append(el('h1', null, album.title));
    (opts.actions || []).forEach(a => tt.append(a));
    hd.append(tt, nav);
    header.append(hd);

    // ---- 日 → 場面 → 写真の格子
    const main = el('main');
    main.append(el('p', 'note', (album.note || '') + '写真を押すと大きく表示され、左右にスワイプで前後へ移れます。'));
    for (const d of album.days) {
      const h2 = el('h2', 'day');
      h2.append(el('span', 'dn', d.label));
      if (d.date) h2.append(el('span', 'dd', d.date));
      main.append(h2);
      // URL の # は開き先に使うので、日付の移動は # を使わずにスクロールだけ
      const jump = el('a');
      jump.href = '#';
      jump.append(d.label);
      if (d.date) jump.append(el('small', null, d.date));
      jump.addEventListener('click', e => { e.preventDefault(); h2.scrollIntoView({ block: 'start' }); });
      nav.append(jump);

      for (const s of d.scenes) {
        const media = s.items.filter(it => it.kind !== 'note').length;
        const sec = el('section', 'scene' + (media ? '' : ' txt')), sh = el('div', 'sh');
        sh.append(el('span', 'st', s.time || ''), el('h3', null, s.title || ''));
        if (s.map) { // その場面にいた場所を Google マップで開く（座標か場所の名前）
          const a = el('a', 'map', '地図');
          a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.map);
          a.target = '_blank'; a.rel = 'noopener noreferrer';
          sh.append(a);
        }
        if (media) sh.append(el('span', 'cnt', media + '枚'));
        sec.append(sh);
        if (s.spent && s.spent.length) {
          const p = el('p', 'spent');
          s.spent.forEach((x, k) => {
            if (k) p.append('　');
            p.append((x.time || '') + ' ' + (x.store || '') + ' ', el('b', null, yen(x.amt)));
          });
          sec.append(p);
        }
        // 写真の格子の途中にメモを挟む（メモが来たら格子を区切る）
        let grid = null;
        const flush = () => { if (grid) { sec.append(grid); grid = null; } };
        for (const it of s.items) {
          if (it.kind === 'note') { flush(); sec.append(memo(it)); continue; }
          if (!grid) grid = el('div', 'grid');
          const i = items.length;
          const a = el('a', 'ph' + (it.kind === 'video' ? ' v' : ''));
          a.href = url(it.video || it.view || it.thumb);
          a.draggable = false; // 写真をつかんで動かしても何も起きないように（落とした先で「開く」扱いにならない）
          const img = el('img');
          img.draggable = false;
          img.loading = 'lazy';
          img.decoding = 'async';
          img.alt = (it.cap ? it.cap + ' ' : '') + (s.title || '') + ' ' + caption(it);
          img.src = url(it.thumb);
          a.append(img);
          if (it.cap) a.append(el('span', 'pc', it.cap)); // 写真の説明
          a.addEventListener('click', e => { e.preventDefault(); open(i); });
          grid.append(a);
          items.push({ it, scene: s.title || '', a });
        }
        flush();
        main.append(sec);
      }
    }

    // ---- 大きく見る（モーダル）
    const lb = el('div');
    lb.id = 'lb';
    lb.hidden = true;
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', '写真');
    const top = el('div', 'lbt'), idx = el('span'), x = el('button', null, '×');
    x.id = 'lbx'; x.setAttribute('aria-label', '閉じる');
    top.append(idx, x);
    const stage = el('div', 'lbs'), spin = el('span', 'spin', '読み込み中…');
    const prev = el('button', 'nv', '‹'), next = el('button', 'nv', '›');
    prev.id = 'lbp'; prev.setAttribute('aria-label', '前へ');
    next.id = 'lbn'; next.setAttribute('aria-label', '次へ');
    stage.append(spin, prev, next);
    const bottom = el('div', 'lbb'), cap = el('p'), meta = el('small'), save = el('a', null, '保存');
    bottom.append(cap, meta, ' ', save);
    lb.append(top, stage, bottom);

    let cur = -1, media = null, opened = false;
    const zoom = pinchZoom(stage);
    function render(i) {
      zoom.reset();
      cur = (i + items.length) % items.length;
      const { it, scene } = items[cur];
      if (media) { if (media.pause) media.pause(); media.removeAttribute('src'); media.remove(); }
      spin.hidden = false;
      spin.textContent = '読み込み中…';
      if (it.kind === 'video') {
        media = el('video');
        media.controls = true;
        media.playsInline = true;
        media.preload = 'metadata';
        media.poster = url(it.thumb);
        media.addEventListener('loadedmetadata', () => { spin.hidden = true; });
        media.addEventListener('error', () => { spin.hidden = false; spin.textContent = 'この端末では再生できませんでした'; });
        media.src = url(it.video);
      } else {
        media = el('img');
        media.alt = scene + ' ' + caption(it);
        media.draggable = false;
        media.src = url(it.thumb); // 小さいほうを先に出して、大きいほうが来たら差し替える
        const full = new Image(), mine = media;
        full.onload = () => { if (media === mine && !mine.dataset.z) { mine.src = full.src; spin.hidden = true; } };
        full.src = url(it.view || it.thumb);
        zoom.attach(media, it.zoom ? url(it.zoom) : null);
      }
      stage.insertBefore(media, stage.firstChild);
      idx.textContent = (cur + 1) + ' / ' + items.length;
      cap.textContent = it.cap || scene;
      meta.textContent = caption(it) + (it.cap && scene ? ' · ' + scene : '');
      const p = it.video || it.view || it.thumb;
      save.href = url(p);
      save.setAttribute('download', p.split('/').pop());
      // 前後の写真を先読み
      [cur + 1, cur - 1].forEach(j => {
        const b = items[(j + items.length) % items.length].it;
        if (b.kind !== 'video') new Image().src = url(b.view || b.thumb);
      });
    }
    function open(i) {
      render(i);
      lb.hidden = false;
      document.body.style.overflow = 'hidden';
      if (!opened) { history.pushState({ lb: 1 }, ''); opened = true; }
      x.focus({ preventScroll: true });
    }
    function close(fromPop) {
      if (lb.hidden) return;
      if (media && media.pause) media.pause();
      lb.hidden = true;
      document.body.style.overflow = '';
      const a = items[cur] && items[cur].a;
      if (a) { a.focus({ preventScroll: true }); a.scrollIntoView({ block: 'nearest' }); }
      if (opened && !fromPop) { opened = false; history.back(); } else opened = false;
    }
    x.addEventListener('click', () => close());
    prev.addEventListener('click', e => { e.stopPropagation(); render(cur - 1); });
    next.addEventListener('click', e => { e.stopPropagation(); render(cur + 1); });
    stage.addEventListener('click', e => { if (e.target === stage && !zoom.active()) close(); });
    addEventListener('popstate', () => close(true));
    addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') render(cur + 1);
      else if (e.key === 'ArrowLeft') render(cur - 1);
    });
    // 横スワイプで前後、下スワイプで閉じる（動画の上は操作に使うので除く）
    let sx = 0, sy = 0, st = 0;
    stage.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (e.target.tagName === 'VIDEO' || zoom.active() || Date.now() - st > 600) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) render(cur + (dx < 0 ? 1 : -1));
      else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) close();
    }, { passive: true });

    root.append(header, main, lb);
    return { count: items.length, open };
  }

  window.AlbumUI = { mount };
})();
