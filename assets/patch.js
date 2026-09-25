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
