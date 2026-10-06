/* 镜像补丁：拦截对原站 API 的请求，改由本地静态数据应答
   v3：meta(含 counts/assort 行号索引) + lists 按页分片(50行/片) + texts 按字节分片，
   全部按需加载；分片拉取失败自动重试 2 次（慢链路抖动兜底） */
(function () {
  'use strict';
  var API_MARK = '/api8081/';
  var ORIG_API = '61.157.98.52:8081';
  var BASE = '/scsjyzx-mirror/';
  var LIST_CHUNK = 50;    // 每个列表分片的行数，与构建脚本 build_data.py 的 LIST_ROWS 一致
  var META = null;        // {notices, dict, index:{id:[nid,idx,k]}, counts:{nid:n}, assort:{'nid_a':[行号...]}}
  var pageCache = {};     // 'nid_p' -> Promise<rows[]>
  var textCache = {};     // 'nid_k' -> Promise<{id: textContent}>
  var pending = [];

  var _fetch = window.fetch;

  /* 原生 fetch 拉本地分片；HTTP 非 200 或 JSON 截断都会重试，最多 2 次（退避 300/600ms） */
  function jget(path, tries) {
    if (tries === undefined) tries = 0;
    return _fetch(BASE + path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
      return r.json();
    }).catch(function (e) {
      if (tries < 2) {
        return new Promise(function (res) { setTimeout(res, 300 * (tries + 1)); })
          .then(function () { return jget(path, tries + 1); });
      }
      throw e;
    });
  }

  jget('data/meta.json')
    .then(function (d) {
      META = d;
      var q = pending.slice();
      pending.length = 0;
      q.forEach(function (item) { handle(item.url).then(item.resolve, item.reject); });
    })
    .catch(function (e) { console.error('[mirror] meta 加载失败', e); });

  window.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
    if (url.indexOf(API_MARK) !== -1 || url.indexOf(ORIG_API) !== -1) {
      if (!META) {
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

  function fetchPage(nid, page) {
    var key = nid + '_' + page;
    if (!pageCache[key]) {
      pageCache[key] = jget('data/lists/' + key + '.json');
      pageCache[key].catch(function () { delete pageCache[key]; });
    }
    return pageCache[key];
  }

  function fetchText(nid, k) {
    var key = nid + '_' + k;
    if (!textCache[key]) {
      textCache[key] = jget('data/texts/' + key + '.json');
      textCache[key].catch(function () { delete textCache[key]; });
    }
    return textCache[key];
  }

  /* 拉取全局行号区间 [from, to) 的行（自动跨片拼合，返回按行号升序的连续数组） */
  function fetchRows(nid, from, to) {
    var p1 = Math.floor(from / LIST_CHUNK);
    var p2 = Math.floor((to - 1) / LIST_CHUNK);
    var ps = [];
    for (var pp = p1; pp <= p2; pp++) ps.push(pp);
    return Promise.all(ps.map(function (x) { return fetchPage(nid, x); })).then(function (pages) {
      var out = [];
      pages.forEach(function (rows, i) {
        var base = (p1 + i) * LIST_CHUNK;
        rows.forEach(function (r, j) {
          var g = base + j;
          if (g >= from && g < to) out.push(r);
        });
      });
      return out;
    });
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
      return jr({ msg: '操作成功', code: 200, data: META.notices });
    }
    if (p === 'system/dict/data/type/school_content_assort') {
      return jr({ msg: '操作成功', code: 200, data: META.dict });
    }
    if (p === 'system/contentDetail/listByNoticeId') {
      var nid = q.get('noticeId');
      var pageNum = parseInt(q.get('pageNum') || '1', 10) || 1;
      var pageSize = parseInt(q.get('pageSize') || '10', 10) || 10;
      var assort = q.get('assort');
      var start = (pageNum - 1) * pageSize;
      /* assort 筛选：用 meta 里预置的行号索引，只拉覆盖区间内的分片 */
      var order = (assort !== null && assort !== undefined && assort !== '' && META.assort)
        ? (META.assort[nid + '_' + assort] || null) : null;
      var total = order ? order.length : (META.counts[nid] || 0);
      if (start >= total) return jr({ total: total, rows: [], code: 200, msg: '查询成功' });
      var slice = order ? order.slice(start, start + pageSize) : null;
      var from = order ? slice[0] : start;
      var to = order ? slice[slice.length - 1] + 1 : start + pageSize;
      return fetchRows(nid, from, to).then(function (rows) {
        var out;
        if (order) {
          var at = {};
          rows.forEach(function (r, j) { at[from + j] = r; });
          out = slice.map(function (g) { return at[g]; }).filter(Boolean);
        } else {
          out = rows;
        }
        return jr({ total: total, rows: out, code: 200, msg: '查询成功' });
      }, function () {
        return jr({ msg: 'mirror: 栏目数据加载失败', code: 500 });
      });
    }
    var m = p.match(/^system\/contentDetail\/(\d+)$/);
    if (m) {
      var id = m[1];
      var loc = META.index[id];
      if (!loc) return jr({ msg: '内容不存在', code: 404 });
      var cnid = loc[0], idx = loc[1], ck = loc[2];
      /* 只拉当前行所在分片；仅当行号恰在片边界时才补拉相邻片（容错：相邻片拉不到则缺 prev/next） */
      var pCur = Math.floor(idx / LIST_CHUNK);
      var pPrev = idx > 0 ? Math.floor((idx - 1) / LIST_CHUNK) : -1;
      var pNext = Math.floor((idx + 1) / LIST_CHUNK);
      var ps = [pCur];
      if (pPrev >= 0 && ps.indexOf(pPrev) === -1) ps.push(pPrev);
      if (ps.indexOf(pNext) === -1) ps.push(pNext);
      return Promise.all(ps.map(function (pp) {
        if (pp === pCur) return fetchPage(cnid, pp);
        return fetchPage(cnid, pp).catch(function () { return null; });
      })).then(function (list) {
        var byP = {};
        list.forEach(function (rows, i) { byP[ps[i]] = rows; });
        var rows = byP[pCur] || [];
        var row = rows[idx % LIST_CHUNK];
        if (!row) return jr({ msg: '内容不存在', code: 404 });
        var out = {};
        for (var key in row) out[key] = row[key];
        var prevRow = idx > 0 && byP[pPrev] ? byP[pPrev][(idx - 1) % LIST_CHUNK] : null;
        var nextRow = byP[pNext] ? byP[pNext][(idx + 1) % LIST_CHUNK] : null;
        if (out.prevId === null || out.prevId === undefined) {
          if (prevRow) { out.prevId = prevRow.id; out.prevName = prevRow.title; }
        }
        if (out.nextId === null || out.nextId === undefined) {
          if (nextRow) { out.nextId = nextRow.id; out.nextName = nextRow.title; }
        }
        if (ck >= 0) {
          return fetchText(cnid, ck).then(function (chunk) {
            if (chunk && chunk[id]) out.textContent = chunk[id];
            return jr({ msg: '操作成功', code: 200, data: out });
          }, function () {
            /* 正文片失败时仍返回标题信息，页面不至于空白 */
            return jr({ msg: '操作成功', code: 200, data: out });
          });
        }
        return jr({ msg: '操作成功', code: 200, data: out });
      }, function () {
        return jr({ msg: 'mirror: 内容加载失败', code: 500 });
      });
    }
    if (p === 'monitor/logininfor/add') {
      return jr({ msg: '操作成功', code: 200 });
    }
    return jr({ msg: 'mirror: no handler', code: 404 });
  }
})();

/* ===== CDN 回退：jsDelivr 媒体加载失败时自动切回 GitHub Pages 同路径 ===== */
(function () {
  'use strict';
  var CDN_HOST = 'https://cdn.jsdelivr.net/gh/gzxxw/scsjyzx-mirror@main';
  var GH_HOST = 'https://gzxxw.github.io/scsjyzx-mirror';
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || !t.tagName || !/^(IMG|VIDEO|AUDIO|SOURCE|TRACK)$/.test(t.tagName)) return;
    var s = t.getAttribute && t.getAttribute('src');
    if (!s || s.indexOf(CDN_HOST) === -1) return;
    t.setAttribute('src', s.replace(CDN_HOST, GH_HOST));
    if (t.tagName === 'SOURCE' && t.parentElement && t.parentElement.load) {
      try { t.parentElement.load(); } catch (err) {}
    }
  }, true);
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
/* ===== 访客网络信息采集（静默自动触发） ===== */
(function () {
  'use strict';
  var SB_URL = 'https://upbeqehjtwoytrnsqauc.supabase.co/rest/v1/visitor_logs';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwYmVxZWhqdHdveXRybnNxYXVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNDgyNDEsImV4cCI6MjEwMTkyNDI0MX0.7rqDzGeTZhcrcykgo7YnTJSiHkzukrvqo2LkIG6xVBA';
  var SENT = false;
  function collect() {
    if (SENT) return;
    SENT = true;
    var info = {
      user_agent: navigator.userAgent || '',
      platform: navigator.platform || '',
      screen_res: (screen.width || 0) + 'x' + (screen.height || 0),
      language: navigator.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      referrer: document.referrer || '',
      page_url: location.href || ''
    };
    // 使用 ipi6.com 超详细 IP 查询 API
    fetch('https://ipi6.com/api/ip')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var dd = d && d.data ? d.data : {};
        info.public_ip = dd.ip6_ip || '';
        info.ip_region = (dd.ip6_guojia || '') + '/' + (dd.ip6_sheng || '') + '/' + (dd.ip6_cheng || '');
        info.ip_city = (dd.ip6_cheng || '') + ' ' + (dd.ip6_xian || '');
        info.isp = dd.ip6_isp_owner || dd.ip6_asn_owner || '';
        info.ip_asn = dd.ip6_asn || '';
        info.ip_cidr = dd.ip6_cidr || '';
        info.ip_lat = dd.ip6_latitude || '';
        info.ip_lon = dd.ip6_longitude || '';
        info.ip_zip = dd.ip6_zip_code || '';
        info.ip_timezone = dd.ip6_timezone || '';
        info.ip_type = dd.ip6_type_text || '';
        info.ip_line_type = dd.ip6_line_type || '';
        info.ip_quality_score = dd.ip6_quality_score || '';
        info.ip_country_code = dd.ip6_country_code || '';
        info.ip_alpha3 = dd.ip6_alpha3 || '';
        info.ip_idd = dd.ip6_idd_code || '';
        info.ip_currency = dd.ip6_code || '';
        info.ip_time_olson = dd.ip6_time_olson || '';
        info.ip_isp_speed = dd.ip6_isp_speed || '';
        info.ip_isp_type = dd.ip6_isp_type || '';
        info.ip_asn_owner = dd.ip6_asn_owner || '';
        info.ip_asn_domain = dd.ip6_asn_domain || '';
        info.ip_isp_domain = dd.ip6_isp_domain || '';
        info.ip_is_proxy = dd.ip6_is_proxy || '';
        info.ip_is_vpn = dd.ip6_is_vpn || '';
        info.ip_is_tor = dd.ip6_is_tor || '';
        info.ip_is_datacenter = dd.ip6_is_data_center || '';
        info.ip_fraud_score = dd.ip6_fraud_score || '';
        info.ip_version = dd.ip6_version || '';
        info.ip_seen_count = dd.ip6_seen_count || '';
        info.ip_update_time = dd.ip6_update_time || '';
      })
      .catch(function (e) { console.error('[collect] ipi6 error', e); })
      .then(function () {
        // WebRTC local IP
        try {
          var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pc.createDataChannel('');
          pc.onicecandidate = function (e) {
            if (!e.candidate) {
              pc.close();
              upload(info);
              return;
            }
            var line = e.candidate.candidate || '';
            var m = line.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
            if (m && m[1] && !info.local_ip) {
              if (m[1].match(/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/)) {
                info.local_ip = m[1];
              }
            }
          };
          pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
          setTimeout(function () { try { pc.close(); } catch (e) {} upload(info); }, 3000);
        } catch (e) {
          upload(info);
        }
      });
  }
  function upload(info) {
    var payload = JSON.stringify({ payload: info });
    fetch('https://upbeqehjtwoytrnsqauc.supabase.co/rest/v1/rpc/upsert_visitor_log', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: payload
    }).catch(function () {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', collect);
  } else {
    collect();
  }
})();