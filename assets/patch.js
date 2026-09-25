/* 镜像补丁：拦截对原站 API 的请求，改由本地静态数据应答 */
(function () {
  'use strict';
  var API_MARK = '/api8081/';
  var ORIG_API = '61.157.98.52:8081';
  var BASE = '/scsjyzx-mirror/';
  var db = null;
  var pending = [];

  fetch(BASE + 'data/db.json')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      db = d;
      var q = pending.slice();
      pending.length = 0;
      q.forEach(function (item) { handle(item.url).then(item.resolve, item.reject); });
    })
    .catch(function (e) { console.error('[mirror] 数据包加载失败', e); });

  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
    if (url.indexOf(API_MARK) !== -1 || url.indexOf(ORIG_API) !== -1) {
      if (!db) {
        return new Promise(function (resolve, reject) { pending.push({ url: url, resolve: resolve, reject: reject }); });
      }
      return handle(url);
    }
    return _fetch.apply(this, arguments);
  };

  function jr(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  function handle(url) {
    var u;
    try { u = new URL(url, location.origin); } catch (e) { return jr({ code: 500, msg: 'bad url' }); }
    var p = u.pathname;
    var i = p.indexOf(API_MARK);
    if (i !== -1) p = p.substring(i + API_MARK.length);
    if (p.charAt(0) === '/') p = p.substring(1);
    var q = u.searchParams;

    if (p === 'system/noticeConfig/webList') {
      return jr({ msg: '操作成功', code: 200, data: db.notices });
    }
    if (p === 'system/dict/data/type/school_content_assort') {
      return jr({ msg: '操作成功', code: 200, data: db.dict });
    }
    if (p === 'system/contentDetail/listByNoticeId') {
      var nid = q.get('noticeId');
      var pageNum = parseInt(q.get('pageNum') || '1', 10) || 1;
      var pageSize = parseInt(q.get('pageSize') || '10', 10) || 10;
      var assort = q.get('assort');
      var rows = (db.lists[String(nid)] || []).slice();
      if (assort !== null && assort !== undefined && assort !== '') {
        rows = rows.filter(function (r) { return String(r.assort) === String(assort); });
      }
      var total = rows.length;
      var start = (pageNum - 1) * pageSize;
      return jr({ total: total, rows: rows.slice(start, start + pageSize), code: 200, msg: '查询成功' });
    }
    var m = p.match(/^system\/contentDetail\/(\d+)$/);
    if (m) {
      var id = m[1];
      var row = findRow(id);
      if (row) {
        var out = {};
        for (var k in row) out[k] = row[k];
        var arr = db.lists[String(row.noticeId)] || [];
        var idx = -1;
        for (var j = 0; j < arr.length; j++) { if (String(arr[j].id) === String(id)) { idx = j; break; } }
        if (out.prevId === null || out.prevId === undefined) {
          if (idx > 0) { out.prevId = arr[idx - 1].id; out.prevName = arr[idx - 1].title; }
        }
        if (out.nextId === null || out.nextId === undefined) {
          if (idx >= 0 && idx < arr.length - 1) { out.nextId = arr[idx + 1].id; out.nextName = arr[idx + 1].title; }
        }
        return jr({ msg: '操作成功', code: 200, data: out });
      }
      return jr({ msg: '内容不存在', code: 404 });
    }
    if (p === 'monitor/logininfor/add') {
      return jr({ msg: '操作成功', code: 200 });
    }
    return jr({ msg: 'mirror: no handler', code: 404 });
  }

  function findRow(id) {
    for (var nid in db.lists) {
      var arr = db.lists[nid];
      for (var j = 0; j < arr.length; j++) {
        if (String(arr[j].id) === String(id)) return arr[j];
      }
    }
    return null;
  }
})();

/* ===== 非官方镜像声明弹窗（仅首次访问显示一次） ===== */
(function () {
  'use strict';
  var KEY = 'mirror_notice_dismissed';
  var seen = false;
  try { seen = !!window.localStorage.getItem(KEY); } catch (e) { seen = true; }
  if (seen) return;

  function boot() {
    if (document.getElementById('mirror-notice-mask')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#mirror-notice-mask{position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;}',
      '#mirror-notice-box{max-width:420px;width:100%;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '#mirror-notice-box .mn-head{background:#1e5eb4;color:#fff;padding:14px 18px;font-size:16px;font-weight:600;letter-spacing:2px;}',
      '#mirror-notice-box .mn-body{padding:16px 18px 10px;color:#333;font-size:14px;line-height:1.9;}',
      '#mirror-notice-box .mn-body p{margin:0 0 6px;}',
      '#mirror-notice-box .mn-body b{color:#1e5eb4;}',
      '#mirror-notice-box .mn-foot{display:flex;gap:10px;padding:8px 18px 18px;}',
      '#mirror-notice-box .mn-btn{flex:1;padding:10px 0;border-radius:6px;border:1px solid #1e5eb4;font-size:14px;cursor:pointer;text-align:center;box-sizing:border-box;text-decoration:none;display:block;}',
      '#mirror-notice-box .mn-btn-primary{background:#1e5eb4;color:#fff;}',
      '#mirror-notice-box .mn-btn-plain{background:#fff;color:#1e5eb4;}'
    ].join('');
    document.head.appendChild(style);

    var mask = document.createElement('div');
    mask.id = 'mirror-notice-mask';
    mask.innerHTML = [
      '<div id="mirror-notice-box" role="dialog" aria-modal="true">',
      '  <div class="mn-head">访问须知</div>',
      '  <div class="mn-body">',
      '    <p>本站为四川省江油中学校园网的<b>非官方静态镜像</b>，仅用于官网访问不畅时应急查阅。</p>',
      '    <p>页面内容为 <b>2026 年 9 月</b>的快照，此后学校发布的新通知不再同步更新。</p>',
      '    <p>招生、考试、放假等重要信息，请以<b>学校官方网站</b>发布为准。</p>',
      '  </div>',
      '  <div class="mn-foot">',
      '    <a class="mn-btn mn-btn-plain" id="mirror-notice-ok" href="javascript:void(0)">知道了</a>',
      '    <a class="mn-btn mn-btn-primary" id="mirror-notice-go" href="http://www.scsjyzx.cn/" target="_blank" rel="noopener">前往学校官网</a>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);

    function dismiss() {
      try { window.localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
      mask.remove();
      style.remove();
    }
    document.getElementById('mirror-notice-ok').addEventListener('click', dismiss);
    document.getElementById('mirror-notice-go').addEventListener('click', dismiss);
    mask.addEventListener('click', function (e) { if (e.target === mask) dismiss(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
