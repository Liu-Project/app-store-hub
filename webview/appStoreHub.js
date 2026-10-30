(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var msgId = 0;
  var pending = {};
  var t = (typeof window.t === 'function') ? window.t : function (key) { return key; };

  window.addEventListener('error', function (e) {
    console.log('[webview] uncaught error:', e.message, e.filename, e.lineno);
  });

  // webview 已被销毁（dispose）时 postMessage 会抛「Webview is disposed」，
  // 统一吞掉，避免异步回调（超时重试、轮询等）在页面销毁后报未捕获错误
  function safePost(msg) {
    try {
      vscode.postMessage(msg);
    } catch (e) {
      /* webview 已销毁，忽略 */
    }
  }

  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++msgId;
      pending[id] = { resolve: resolve, reject: reject };
      console.log('[webview] send', id, type, JSON.stringify(payload || {}));
      safePost({ id: id, type: type, payload: payload || {} });
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          console.log('[webview] timeout', id, type);
          reject(new Error(t('requestTimeout', type)));
        }
      }, 30000);
    });
  }

  function log(msg) {
    console.log('[webview]', msg);
    try {
      safePost({ type: 'log', message: msg });
    } catch (e) {
      /* 忽略 */
    }
  }

  function apiFetch(path, options) {
    var url = state.activeUrl + path;
    console.log('[webview] fetch', url);
    return fetch(url, options || {}).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) {
          throw new Error((j && j.message) || ('HTTP ' + res.status));
        }
        return j;
      });
    });
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    console.log('[webview] recv', JSON.stringify(m));
    if (!m) return;
    if (typeof m.id === 'number' && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.ok) {
        console.log('[webview] resolve', m.id, 'dataType=' + (m.data === null ? 'null' : typeof m.data));
        p.resolve(m.data);
      } else {
        console.log('[webview] reject', m.id, m.error);
        p.reject(new Error(m.error || t('requestFailed')));
      }
    } else if (m.type === 'refresh') {
      loadAll();
    } else if (m.type === 'searchCategory') {
      // 详情页分类点击 → 回到主面板按分类过滤
      state.category = m.category || '';
      state.page = 1;
      loadAll();
    }
  });

  var state = {
    sources: [],
    activeUrl: '',
    keyword: '',
    page: 1,
    pageSize: 30,
    total: 0,
    apps: [],
    localExtensions: {},
    installed: [],
    view: 'market',
    currentApp: null,
    searchTimer: null,
    loading: false,
    hasMore: true,
    viewType: 'popular',
    sort: 'relevance',
    category: '',
    categories: []
  };

  var els = {};

  function assetUrl(p) {
    if (!p) return '';
    if (/^https?:\/\//.test(p)) return p;
    return state.activeUrl + p;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function renderShell() {
    document.body.innerHTML =
      '<header class="header">' +
      '<div class="logo"><div class="logo-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 8h16l-1.2 11.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8Z" fill="#fff" fill-opacity="0.95"/><path d="M9 10V7a3 3 0 0 1 6 0v3" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg></div><span>' + t('app.title') + '</span></div>' +
      '<div class="search-box"><input id="searchInput" type="text" placeholder="' + t('search.placeholder') + '" /></div>' +
      '<select id="sourceSelect" class="source-select" title="' + t('source.switch.title') + '"></select>' +
      '<button id="sourceManageBtn" class="btn secondary small" title="' + t('source.switch.title') + '">' + t('source.manage') + '</button>' +
      '<span id="statusBadge" class="status-badge"></span>' +
      '<select id="viewSelect" class="view-select" title="' + t('view.select.title') + '">' +
      '<option value="popular">' + t('view.popular') + '</option>' +
      '<option value="recentlyUpdated">' + t('view.recentlyUpdated') + '</option>' +
      '</select>' +
      '<button id="filterBtn" class="btn icon-btn" title="' + t('filter.title') + '">&#9881;</button>' +
      '</header>' +
      '<div id="filterPanel" class="filter-panel hidden"></div>' +
      '<div id="content" class="content"></div>' +
      '<div id="toastContainer" class="toast-container"></div>' +
      '<div id="sourceModal" class="modal-mask hidden"></div>';

    els.searchInput = el('searchInput');
    els.sourceSelect = el('sourceSelect');
    els.sourceManageBtn = el('sourceManageBtn');
    els.statusBadge = el('statusBadge');
    els.content = el('content');
    els.toastContainer = el('toastContainer');
    els.sourceModal = el('sourceModal');
    els.viewSelect = el('viewSelect');
    els.filterBtn = el('filterBtn');
    els.filterPanel = el('filterPanel');

    els.searchInput.addEventListener('input', function () {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.keyword = els.searchInput.value.trim();
        var pq = parseQuery(state.keyword);
        if (pq.installed) {
          if (state.view !== 'installed') {
            switchView('installed');
          } else {
            filterInstalled();
          }
          return;
        }
        if (state.view === 'installed') {
          filterInstalled();
        } else {
          state.page = 1;
          saveViewState();
          loadApps();
        }
      }, 300);
    });

    // 事件委托：卡片点击/安装/齿轮等操作统一处理，滚动追加的卡片无需重复绑定
    els.content.addEventListener('click', handleContentClick);

    els.content.addEventListener(
      'error',
      function (e) {
        var t = e.target;
        if (t && t.tagName === 'IMG' && t.classList.contains('app-icon')) {
          var letter = t.getAttribute('data-letter') || '?';
          var div = document.createElement('div');
          div.className = t.className + ' placeholder';
          div.textContent = letter;
          if (t.parentNode) t.parentNode.replaceChild(div, t);
        }
      },
      true
    );

    els.sourceSelect.addEventListener('change', function () {
      var url = els.sourceSelect.value;
      if (url && url !== state.activeUrl) {
        switchSource(url);
      }
    });

    els.sourceManageBtn.addEventListener('click', openSourceModal);

    els.viewSelect.addEventListener('change', function () {
      state.viewType = els.viewSelect.value;
      state.sort = state.viewType === 'recentlyUpdated' ? 'updated' : 'relevance';
      state.page = 1;
      saveViewState();
      loadApps();
    });

    els.filterBtn.addEventListener('click', function () {
      toggleFilterPanel();
    });
  }

  function toggleFilterPanel() {
    if (els.filterPanel.classList.contains('hidden')) {
      renderFilterPanel();
      els.filterPanel.classList.remove('hidden');
    } else {
      els.filterPanel.classList.add('hidden');
    }
  }

  /** 渲染过滤与排序面板（分类 / 排序 / 搜索过滤器），对齐 VS Code 漏斗菜单 */
  function renderFilterPanel() {
    var sortHtml = [
      ['relevance', t('sort.relevance')],
      ['installs', t('sort.installs')],
      ['rating', t('sort.rating')],
      ['name', t('sort.name')],
      ['updated', t('sort.updated')]
    ]
      .map(function (s) {
        return (
          '<label class="fp-opt">' +
          '<input type="radio" name="fp-sort" value="' + s[0] + '"' +
          (state.sort === s[0] ? ' checked' : '') + ' /> ' + s[1] +
          '</label>'
        );
      })
      .join('');

    var catHtml = (state.categories || []).length
      ? '<div class="fp-section-label">' + t('filter.category') + '</div>' +
        '<div class="fp-cats">' +
        state.categories
          .map(function (c) {
            return (
              '<span class="chip' + (state.category === c.id ? ' active' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</span>'
            );
          })
          .join('') +
        '</div>'
      : '<div class="fp-section-label">' + t('filter.category') + '</div><div class="fp-loading">' + t('loading') + '</div>';

    var instFilters = [
      ['installed', t('filter.installed')],
      ['builtin', t('filter.builtin')]
    ]
      .map(function (f) {
        return (
          '<label class="fp-opt">' +
          '<input type="checkbox" data-inst-filter="' + f[0] + '"' +
          (state.keyword.indexOf('@' + f[0]) >= 0 ? ' checked' : '') + ' /> ' + f[1] +
          '</label>'
        );
      })
      .join('');

    els.filterPanel.innerHTML =
      '<div class="fp-title">' + t('filter.title') + '</div>' +
      '<div class="fp-section-label">' + t('filter.sort') + '</div>' +
      '<div class="fp-opts">' + sortHtml + '</div>' +
      catHtml +
      '<div class="fp-section-label">' + t('filter.searchFilters') + '</div>' +
      '<div class="fp-opts">' + instFilters + '</div>';

    els.filterPanel.querySelectorAll('input[name="fp-sort"]').forEach(function (r) {
      r.addEventListener('change', function () {
        state.sort = r.value;
        state.page = 1;
        saveViewState();
        loadApps();
      });
    });

    els.filterPanel.querySelectorAll('[data-cat]').forEach(function (c) {
      c.addEventListener('click', function () {
        var id = c.getAttribute('data-cat');
        state.category = state.category === id ? '' : id;
        state.page = 1;
        saveViewState();
        loadApps();
        renderFilterPanel();
      });
    });

    els.filterPanel.querySelectorAll('[data-inst-filter]').forEach(function (f) {
      f.addEventListener('change', function () {
        var kind = f.getAttribute('data-inst-filter');
        var tokens = (els.searchInput.value.match(/@[a-zA-Z]+/g) || []).filter(
          function (t) { return t === '@installed' || t === '@builtin'; }
        );
        if (f.checked) {
          tokens.push('@' + kind);
        } else {
          tokens = tokens.filter(function (t) { return t !== '@' + kind; });
        }
        var plain = els.searchInput.value
          .replace(/@[a-zA-Z]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        els.searchInput.value = (plain ? plain + ' ' : '') + tokens.join(' ');
        els.searchInput.dispatchEvent(new Event('input'));
        renderFilterPanel();
      });
    });

    if (!state.categories.length) {
      request('getCategories')
        .then(function (cats) {
          state.categories = (cats || []).map(function (c) {
            return { id: c.id, name: c.name };
          });
          if (!els.filterPanel.classList.contains('hidden')) {
            renderFilterPanel();
          }
        })
        .catch(function () {});
    }
  }

  /** 关闭过滤面板 */
  function closeFilterPanel() {
    if (els.filterPanel) els.filterPanel.classList.add('hidden');
  }

  function switchView(v) {
    if (v === state.view) return;
    state.view = v;
    if (v === 'installed') {
      loadInstalled();
    } else {
      state.page = 1;
      saveViewState();
      loadApps();
    }
  }

  function loadInstalled() {
    setStatus(t('loading'));
    return request('getInstalled')
      .then(function (list) {
        if (state.view !== 'installed') return;
        state.installed = list || [];
        setStatus(state.activeUrl);
        if (parseQuery(state.keyword).installed) {
          filterInstalled();
        } else {
          renderInstalled(state.installed);
        }
      })
      .catch(function (e) {
        setStatus(t('loadFailed'), true);
        els.content.innerHTML =
          '<div class="error-box">' +
          '<div class="msg">' + esc(e.message) + '</div>' +
          '<button class="btn" id="retryBtn">' + t('retry') + '</button>' +
          '</div>';
        var retryBtn = el('retryBtn');
        if (retryBtn) retryBtn.addEventListener('click', loadInstalled);
      });
  }

  function filterInstalled() {
    var pq = parseQuery(state.keyword);
    var kw = pq.keyword.toLowerCase();
    var list = (state.installed || []).filter(function (ext) {
      if (pq.builtin && !ext.builtin) return false;
      if (pq.enabled && !ext.enabled) return false;
      if (pq.disabled && ext.enabled) return false;
      return (
        !kw ||
        (ext.name + ' ' + ext.publisher + ' ' + ext.id + ' ' + (ext.description || '')).toLowerCase().indexOf(kw) >= 0
      );
    });
    renderInstalled(list);
  }

  function renderInstalled(list) {
    if (!list.length) {
      els.content.innerHTML = '<div class="state">' + t('installed.empty') + '</div>';
      return;
    }
    var html = '<div class="result-meta">' + t('installed.count', list.length) + '</div>';
    html += '<div class="inst-list">';
    list.forEach(function (ext) {
      var builtinTag = ext.builtin ? '<span class="tag">' + t('builtin') + '</span>' : '';
      var stateTag = ext.enabled
        ? '<span class="tag enabled-tag">' + t('enabled') + '</span>'
        : '<span class="tag disabled-tag">' + t('disabled') + '</span>';
      var ops = '';
      if (!ext.builtin) {
        ops +=
          '<button class="btn small secondary" data-ext-toggle="' + esc(ext.id) + '">' +
          (ext.enabled ? t('disable') : t('enable')) +
          '</button>' +
          '<button class="btn small danger" data-ext-uninstall="' + esc(ext.id) + '">' + t('uninstall') + '</button>';
      }
      var letter = esc((ext.name || '?').charAt(0).toUpperCase());
      var iconHtml = ext.icon
        ? '<img class="inst-icon" src="' + esc(ext.icon) + '" alt="" />'
        : '<div class="inst-icon placeholder">' + letter + '</div>';
      html +=
        '<div class="inst-item' + (ext.enabled ? '' : ' inst-disabled') + '">' +
        iconHtml +
        '<div class="inst-info">' +
        '<div class="inst-name">' + esc(ext.name) + builtinTag + stateTag + '</div>' +
        '<div class="inst-sub">' + esc(ext.publisher) + ' · v' + esc(ext.version) + '</div>' +
        '<div class="inst-desc">' + esc(ext.description || '') + '</div>' +
        '</div>' +
        '<div class="inst-ops">' + ops + '</div>' +
        '</div>';
    });
    html += '</div>';
    els.content.innerHTML = html;

    els.content.querySelectorAll('[data-ext-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ext-toggle');
        request('toggleExtension', { id: id })
          .then(function (d) {
            if (d && d.done) {
              showToast(t('op.doneReload', d.action || t('enabled')));
            }
          })
          .catch(function (e) {
            showToast(t('op.failed', t('enabled'), e.message), true);
          });
      });
    });
    els.content.querySelectorAll('[data-ext-uninstall]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ext-uninstall');
        request('uninstallLocal', { id: id })
          .then(function () {
            showToast(t('uninstalled.reload'));
            loadInstalled();
          })
          .catch(function (e) {
            showToast(t('op.failed', t('uninstall'), e.message), true);
          });
      });
    });
  }

  function handleContentClick(e) {
    var node = e.target;
    while (node && node !== els.content) {
      if (node.getAttribute) {
        var manage = node.getAttribute('data-manage');
        if (manage) {
          e.stopPropagation();
          doManage(manage);
          return;
        }
        var install = node.getAttribute('data-install');
        if (install) {
          e.stopPropagation();
          action('install', install);
          return;
        }
        var open = node.getAttribute('data-open');
        if (open) {
          e.stopPropagation();
          openDetail(open);
          return;
        }
      }
      node = node.parentNode;
    }
  }

  function openDetail(id) {
    setStatus(t('detail.opening'));
    // 对齐 VS Code：把列表已加载的数据传给详情页，立即渲染主体
    var app = null;
    for (var i = 0; i < state.apps.length; i++) {
      if (state.apps[i].id === id) { app = state.apps[i]; break; }
    }
    request('openDetail', { id: id, app: app }).catch(function (e) {
      showToast(t('detail.openFailed', e.message), true);
      setStatus(state.activeUrl);
    });
  }

  function doManage(id) {
    request('manageApp', { id: id })
      .then(function (d) {
        if (d && d.changed) {
          loadLocalExtensions().then(function () {
            state.page = 1;
            saveViewState();
            loadApps();
          });
        }
      })
      .catch(function (err) {
        showToast(t('manage.failed', err.message), true);
      });
  }

  function setStatus(text, isError) {
    els.statusBadge.textContent = text || '';
    els.statusBadge.className = 'status-badge' + (isError ? ' error' : '');
  }

  function showToast(text, isError) {
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = text;
    els.toastContainer.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 3200);
  }

  function iconHtml(app, cls) {
    var letter = esc((app.displayName || app.name || '?').charAt(0).toUpperCase());
    if (app.icon) {
      return '<img class="' + cls + '" src="' + esc(assetUrl(app.icon)) + '" alt="' + letter + '" data-letter="' + letter + '">';
    }
    return '<div class="' + cls + ' placeholder">' + letter + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  /** 解析 VS Code 风格搜索语法：@installed / @builtin / @enabled / @disabled / @category:xxx / @tag:xxx / @sort:xxx，其余为关键词 */
  function parseQuery(q) {
    var category = '';
    var tag = '';
    var sort = '';
    var installed = false;
    var builtin = false;
    var enabled = false;
    var disabled = false;
    var rest = q;
    var m;
    m = q.match(/@category:([^\s]+)/);
    if (m) {
      category = m[1];
      rest = rest.replace(m[0], ' ');
    }
    m = q.match(/@tag:([^\s]+)/);
    if (m) {
      tag = m[1];
      rest = rest.replace(m[0], ' ');
    }
    m = q.match(/@sort:([a-zA-Z]+)/);
    if (m) {
      sort = m[1];
      rest = rest.replace(m[0], ' ');
    }
    if (/\@installed\b/.test(q)) {
      installed = true;
      rest = rest.replace(/@installed\b/g, ' ');
    }
    if (/\@builtin\b/.test(q)) {
      builtin = true;
      rest = rest.replace(/@builtin\b/g, ' ');
    }
    if (/\@enabled\b/.test(q)) {
      enabled = true;
      rest = rest.replace(/@enabled\b/g, ' ');
    }
    if (/\@disabled\b/.test(q)) {
      disabled = true;
      rest = rest.replace(/@disabled\b/g, ' ');
    }
    return {
      keyword: rest.trim(),
      category: category,
      tag: tag,
      sort: sort,
      installed: installed,
      builtin: builtin,
      enabled: enabled,
      disabled: disabled
    };
  }

  /** 将排序标识映射为 Gallery sortBy（0=相关度 1=最近更新 2=安装量 3=名称 6=评分） */
  function sortToGallery(s) {
    if (s === 'installs') return 2;
    if (s === 'rating') return 6;
    if (s === 'name') return 3;
    if (s === 'updated') return 1;
    return 0;
  }

  /* ---------------- sources ---------------- */

  function loadSources() {
    return request('getSources').then(function (d) {
      state.sources = d.sources || [];
      state.activeUrl = d.activeUrl || '';
      renderSourceSelect();
      setStatus(state.sources.length ? state.activeUrl : t('source.notConfigured'), !state.sources.length);
      return state.activeUrl;
    });
  }

  function renderSourceSelect() {
    var html = '';
    state.sources.forEach(function (s) {
      html += '<option value="' + esc(s.url) + '"' + (s.url === state.activeUrl ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    });
    els.sourceSelect.innerHTML = html || '<option value="">' + t('source.none') + '</option>';
  }

  function switchSource(url) {
    setStatus(t('source.switching'));
    request('setActiveSource', { url: url })
      .then(function () {
        state.activeUrl = url;
        state.page = 1;
        // 保留搜索词：切换源后用当前关键词直接在新源重新搜索，无需重新输入
        renderSourceSelect();
        loadAll();
      })
      .catch(function (e) {
        setStatus(state.activeUrl);
        showToast(t('source.switchFailed', e.message), true);
      });
  }

  function openSourceModal() {
    var listHtml = '';
    state.sources.forEach(function (s) {
      var isActive = s.url === state.activeUrl;
      listHtml +=
        '<div class="source-item' + (isActive ? ' active' : '') + '" data-src-item="' + esc(s.url) + '">' +
        '<div class="src-fields">' +
        '<input class="src-field-label" type="text" value="' + esc(s.label) + '" data-src-label="' + esc(s.url) + '" placeholder="' + t('source.namePlaceholder') + '" />' +
        '<input class="src-field-url" type="text" value="' + esc(s.url) + '" data-src-url="' + esc(s.url) + '" placeholder="' + t('source.urlPlaceholder') + '" />' +
        '<label class="src-field-concurrent" title="' + t('source.concurrentHelp') + '">' +
        '<input type="checkbox" data-src-concurrent="' + esc(s.url) + '"' + (s.concurrent ? ' checked' : '') + ' /> ' + t('source.concurrent') +
        '</label>' +
        '</div>' +
        '<div class="src-actions">' +
        (isActive ? '' : '<button class="btn small secondary" data-src-active="' + esc(s.url) + '">' + t('source.setActive') + '</button>') +
        '<button class="btn small danger" data-src-del="' + esc(s.url) + '">' + t('source.delete') + '</button>' +
        '</div>' +
        '</div>';
    });
    els.sourceModal.innerHTML =
      '<div class="modal">' +
      '<div class="modal-header"><span>' + t('source.manageTitle') + '</span><button class="modal-close" data-close="1">&times;</button></div>' +
      '<div class="modal-body">' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">' + t('source.help') + '<b>' + esc(state.activeUrl || t('source.noneActive')) + '</b></div>' +
      '<div id="sourceList">' + listHtml + '</div>' +
      '<div class="form-row">' +
      '<input id="newSrcLabel" type="text" placeholder="' + t('source.newNamePlaceholder') + '" />' +
      '<input id="newSrcUrl" type="text" placeholder="' + t('source.newUrlPlaceholder') + '" />' +
      '</div>' +
      '<label class="src-field-concurrent" title="' + t('source.concurrentHelpNew') + '">' +
      '<input id="newSrcConcurrent" type="checkbox" /> ' + t('source.newConcurrent') +
      '</label>' +
      '<div style="display:flex;justify-content:flex-end"><button id="addSrcBtn" class="btn small">' + t('source.add') + '</button></div>' +
      '</div>' +
      '<div class="modal-footer"><button class="btn secondary" data-close="1">' + t('close') + '</button></div>' +
      '</div>';

    els.sourceModal.classList.remove('hidden');
    els.sourceModal.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { els.sourceModal.classList.add('hidden'); });
    });
    els.sourceModal.querySelectorAll('[data-src-active]').forEach(function (b) {
      b.addEventListener('click', function () {
        var url = b.getAttribute('data-src-active');
        if (url) switchSource(url);
        els.sourceModal.classList.add('hidden');
      });
    });
    els.sourceModal.querySelectorAll('[data-src-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var url = b.getAttribute('data-src-del');
        removeSource(url);
      });
    });
    els.sourceModal.querySelectorAll('[data-src-label], [data-src-url]').forEach(function (input) {
      var oldUrl = input.getAttribute(input.getAttribute('data-src-label') !== null ? 'data-src-label' : 'data-src-url');
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
      input.addEventListener('blur', function () {
        saveEditedSource(oldUrl, input);
      });
    });
    els.sourceModal.querySelectorAll('[data-src-concurrent]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var url = cb.getAttribute('data-src-concurrent');
        saveConcurrentSource(url, cb.checked);
      });
    });
    el('addSrcBtn').addEventListener('click', addSource);
  }

  function saveConcurrentSource(url, checked) {
    var list = state.sources.map(function (s) {
      if (s.url === url) {
        return { label: s.label, url: s.url, concurrent: checked };
      }
      return s;
    });
    request('setSources', { sources: list })
      .then(function (d) {
        state.sources = d.sources || [];
        state.activeUrl = d.activeUrl || state.activeUrl;
        showToast(checked ? t('source.concurrentOn') : t('source.concurrentOff'));
      })
      .catch(function (e) { showToast(t('saveFailed', e.message), true); });
  }

  function saveEditedSource(oldUrl, input) {
    var isLabel = input.getAttribute('data-src-label') !== null;
    var value = input.value.trim();
    if (!value) {
      showToast(t('source.nameUrlRequired'), true);
      openSourceModal();
      return;
    }
    if (!isLabel && !/^https?:\/\//i.test(value)) {
      showToast(t('source.urlScheme'), true);
      openSourceModal();
      return;
    }
    var src = state.sources.find(function (s) { return s.url === oldUrl; });
    if (!src) return;
    var next = { label: src.label, url: src.url, concurrent: src.concurrent };
    if (isLabel) {
      next.label = value;
    } else {
      if (value !== oldUrl && state.sources.some(function (s) { return s.url === value; })) {
        showToast(t('source.urlExists'), true);
        openSourceModal();
        return;
      }
      next.url = value;
    }
    if (next.label === src.label && next.url === src.url) {
      return;
    }
    var list = state.sources.map(function (s) {
      return s.url === oldUrl ? next : s;
    });
    request('setSources', { sources: list })
      .then(function (d) {
        state.sources = d.sources || [];
        state.activeUrl = d.activeUrl || state.activeUrl;
        renderSourceSelect();
        setStatus(state.activeUrl);
        showToast(t('source.saved'));
        openSourceModal();
        loadAll();
      })
      .catch(function (e) { showToast(t('saveFailed', e.message), true); });
  }

  function collectSources(extra) {
    var list = state.sources.slice();
    if (extra) list.push(extra);
    return list;
  }

  function addSource() {
    var label = el('newSrcLabel').value.trim();
    var url = el('newSrcUrl').value.trim();
    if (!label || !url) {
      showToast(t('source.fillRequired'), true);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showToast(t('source.urlScheme'), true);
      return;
    }
    if (state.sources.some(function (s) { return s.url === url; })) {
      showToast(t('source.exists'), true);
      return;
    }
    var concurrent = !!el('newSrcConcurrent') && el('newSrcConcurrent').checked;
    request('setSources', { sources: collectSources({ label: label, url: url, concurrent: concurrent }) })
      .then(function (d) {
        state.sources = d.sources || [];
        state.activeUrl = d.activeUrl || state.activeUrl;
        renderSourceSelect();
        setStatus(state.activeUrl);
        showToast(t('source.added', label));
        openSourceModal();
      })
      .catch(function (e) { showToast(t('addFailed', e.message), true); });
  }

  function removeSource(url) {
    var list = state.sources.filter(function (s) { return s.url !== url; });
    if (!list.length) {
      showToast(t('source.keepOne'), true);
      return;
    }
    request('setSources', { sources: list })
      .then(function (d) {
        state.sources = d.sources || [];
        state.activeUrl = d.activeUrl || state.activeUrl;
        renderSourceSelect();
        setStatus(state.activeUrl);
        showToast(t('source.deleted'));
        openSourceModal();
        loadAll();
      })
      .catch(function (e) { showToast(t('deleteFailed', e.message), true); });
  }

  /* ---------------- list ---------------- */

  function loadAll() {
    log('loadAll 开始');
    return Promise.all([loadSources(), loadLocalExtensions()])
      .then(function () {
        log('loadSources + loadLocalExtensions 完成，开始 loadApps');
        return loadApps();
      })
      .catch(function (e) {
        log('loadAll 失败：' + e.message);
        setStatus(t('connFailed'), true);
        showToast(e.message, true);
      });
  }

  function loadLocalExtensions() {
    return request('getLocalExtensions')
      .then(function (list) {
        state.localExtensions = {};
        (list || []).forEach(function (ext) {
          if (ext && ext.id) {
            state.localExtensions[ext.id] = ext.version || '';
          }
        });
        log('loadLocalExtensions 完成，共 ' + Object.keys(state.localExtensions).length + ' 个');
        return list;
      })
      .catch(function (e) {
        state.localExtensions = {};
        log('loadLocalExtensions 失败：' + e.message);
      });
  }

  function loadApps() {
    var isFirst = state.page <= 1;
    state.loading = true;
    if (isFirst) {
      setStatus(t('loading'));
      els.content.innerHTML = '<div class="state"><div class="spinner"></div>' + t('loadingApps') + '</div>';
    } else {
      var wrap = el('loadMoreWrap');
      if (wrap) wrap.innerHTML = '<div class="load-more">' + t('loading') + '</div>';
    }
    var pq = parseQuery(state.keyword);
    // 排序优先级：@sort:xxx > 过滤面板排序（state.sort 已由视图默认联动）
    var sortKey = pq.sort || state.sort || 'relevance';
    log('loadApps 请求 getApps keyword=' + (pq.keyword || '') + ' category=' + (state.category || pq.category || '') + ' tag=' + (pq.tag || '') + ' sortBy=' + sortToGallery(sortKey) + ' page=' + state.page + ' pageSize=' + state.pageSize);
    return request('getApps', {
      keyword: pq.keyword,
      category: state.category || pq.category || undefined,
      tag: pq.tag || undefined,
      sortBy: sortToGallery(sortKey),
      page: state.page,
      pageSize: state.pageSize
    })
      .then(function (d) {
        if (state.view !== 'market') {
          state.loading = false;
          return;
        }
        var list = d.list || [];
        state.apps = isFirst ? list : state.apps.concat(list);
        state.total = d.total || 0;
        state.loading = false;
        setStatus(state.activeUrl);
        log('loadApps 收到 ' + list.length + ' 条 total=' + (d.total || 0));
        if (isFirst) {
          renderGrid();
        } else {
          appendApps(list);
        }
      })
      .catch(function (e) {
        state.loading = false;
        if (state.view !== 'market') return;
        setStatus(t('connFailed'), true);
        log('loadApps 失败：' + e.message);
        if (isFirst) {
          els.content.innerHTML =
            '<div class="error-box">' +
            '<div class="msg">' + esc(e.message) + '</div>' +
            '<button class="btn" id="retryBtn">' + t('retry') + '</button>' +
            '</div>';
          var retryBtn = el('retryBtn');
          if (retryBtn) retryBtn.addEventListener('click', function () { state.page = 1; loadApps(); });
        } else {
          var wrap = el('loadMoreWrap');
          if (wrap) {
            wrap.innerHTML = '<div class="load-more error" id="loadMoreRetry">' + t('loadMoreFailed') + '</div>';
            var r = el('loadMoreRetry');
            if (r) r.addEventListener('click', function () { loadApps(); });
          }
        }
      });
  }

  function renderGrid() {
    if (!state.apps.length) {
      els.content.innerHTML = '<div class="state">' + t('apps.empty') + '</div>';
      return;
    }
    var html = '<div class="result-meta">' + t('apps.count', state.total) + '</div>';
    html += '<div class="app-grid">';
    state.apps.forEach(function (app) {
      html += appCard(app);
    });
    html += '</div>';
    html += '<div id="loadMoreWrap" class="load-more-wrap"></div>';
    els.content.innerHTML = html;
    updateLoadMore();
  }

  function appendApps(list) {
    var grid = els.content.querySelector('.app-grid');
    if (grid && list.length) {
      list.forEach(function (app) {
        grid.insertAdjacentHTML('beforeend', appCard(app));
      });
    }
    updateLoadMore();
  }

  var loadMoreObserver = null;

  function initInfiniteScroll() {
    var sentinel = el('loadMore');
    if (!sentinel) return;
    if (loadMoreObserver) loadMoreObserver.disconnect();
    loadMoreObserver = new IntersectionObserver(function (entries) {
      if (entries[0] && entries[0].isIntersecting && !state.loading && state.hasMore) {
        state.page += 1;
        saveViewState();
        loadApps();
      }
    }, { root: null, rootMargin: '120px' });
    loadMoreObserver.observe(sentinel);
  }

  function updateLoadMore() {
    var wrap = el('loadMoreWrap');
    if (!wrap) return;
    state.hasMore = state.apps.length < state.total;
    if (state.hasMore) {
      wrap.innerHTML = '<div id="loadMore" class="load-more">' + t('loading') + '</div>';
      initInfiniteScroll();
    } else if (state.apps.length) {
      wrap.innerHTML = '<div class="load-more end">' + t('apps.allLoaded', state.total) + '</div>';
    }
  }

  function appCard(app) {
    var tags = '';
    (app.tags || []).slice(0, 2).forEach(function (t) {
      tags += '<span class="tag">' + esc(t) + '</span>';
    });
    var localVer = state.localExtensions[app.publisher + '.' + app.name];
    var installed = !!app.installed || !!localVer;
    var updatable = installed && !!app.updatable;
    var btn = '';
    if (updatable) {
      btn = '<button class="btn small" data-install="' + esc(app.id) + '">' + t('update') + '</button>';
    } else if (!installed && app.hasPackage) {
      btn = '<button class="btn small" data-install="' + esc(app.id) + '">' + t('install') + '</button>';
    } else if (!installed) {
      btn = '<button class="btn secondary small" disabled>' + t('demo') + '</button>';
    }
    var stats = [];
    if (app.rating > 0) {
      stats.push('⭐ ' + app.rating.toFixed(1) + (app.ratingCount ? ' (' + app.ratingCount + ')' : ''));
    }
    if (app.downloadCount > 0) {
      stats.push(t('downloads', fmtCount(app.downloadCount)));
    }
    var badges = '';
    if (updatable) {
      badges += '<span class="tag updatable-tag">' + t('updatable') + '</span>';
    }
    if (installed) {
      badges += '<span class="tag installed-tag">' + t('installed') + '</span>';
    }
    return '' +
      '<div class="app-card" data-open="' + esc(app.id) + '">' +
      '<div class="card-top">' +
      iconHtml(app, 'app-icon') +
      '<div class="card-info">' +
      '<div class="card-name">' + esc(app.displayName || app.name) + '</div>' +
      '<div class="card-publisher">' + esc(app.publisher) + ' · v' + esc(app.version) + '</div>' +
      (stats.length ? '<div class="card-stats">' + esc(stats.join(' · ')) + '</div>' : '') +
      '</div>' +
      '</div>' +
      '<div class="card-desc">' + esc(app.description || '') + '</div>' +
      '<div class="card-bottom">' +
      '<div class="meta-row">' + tags + badges + '</div>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:6px;align-items:center">' + btn + '</div>' +
      '</div>';
  }

  /* ---------------- actions ---------------- */

  function saveViewState() {
    request('setViewState', {
      keyword: state.keyword,
      page: state.page,
      viewType: state.viewType,
      sort: state.sort,
      category: state.category
    }).catch(function () {});
  }

  function action(type, id) {
    var labels = {
      install: t('install'),
      uninstall: t('uninstall'),
      update: t('update'),
      download: t('download')
    };
    showToast(t('action.doing', labels[type]));
    request(type, { id: id })
      .then(function () {
        showToast(t('action.done', labels[type]));
        if (type !== 'download') {
          loadLocalExtensions().then(function () {
            state.page = 1;
            saveViewState();
            loadApps();
          });
        }
      })
      .catch(function (e) {
        showToast(t('action.failed', labels[type], e.message), true);
      });
  }

  /* ---------------- init ---------------- */

  renderShell();
  request('getViewState')
    .then(function (vs) {
      if (vs) {
        state.keyword = vs.keyword || '';
        state.page = (typeof vs.page === 'number' && vs.page > 0) ? vs.page : 1;
        state.viewType = vs.viewType || 'popular';
        state.sort = vs.sort || 'relevance';
        state.category = vs.category || '';
        if (els.searchInput) {
          els.searchInput.value = state.keyword;
        }
        if (els.viewSelect) {
          els.viewSelect.value = state.viewType;
        }
      }
      loadAll();
    })
    .catch(function () {
      loadAll();
    });
})();
