(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var state = { app: null, curVersion: '', activeTab: 'Details', manifest: null, pendingContent: {}, resources: null, tabHtml: {}, imageCache: {} };

  // 渲染引擎：直接复制 VS Code 扩展详情 README 渲染链（markdownDocumentRenderer.ts renderMarkdownDocument）
  //   marked + markedGfmHeadingIdPlugin（heading 锚点 id）+ DOMPurify 净化
  // 注意：本工程打包的 marked 为 v12（渲染器改为位置参数 (arg1, arg2, ...)，且无 this.parser），
  // 故渲染器方法使用 v12 签名，不能照抄旧版 VS Code 的 token + this.parser 写法。
  var md = null;
  var mdRenderBaseUrl = '';
  if (window.marked && window.marked.Marked) {
    md = new window.marked.Marked(
      window.gfmHeadingIdPlugin && window.gfmHeadingIdPlugin(),
      {
        renderer: {
          image: function (href, title, text) {
            var src = toAbs(href, mdRenderBaseUrl);
            var out = '<img src="' + esc(src) + '" alt="' + esc(text) + '"';
            if (title) out += ' title="' + esc(title) + '"';
            out += '>';
            return out;
          },
          link: function (href, title, text) {
            var h = toAbs(href, mdRenderBaseUrl);
            return '<a href="' + esc(h) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + text + '</a>';
          },
        },
      }
    );
  }

  function post(type, payload) {
    vscode.postMessage({ type: type, payload: payload || {} });
  }

  function toast(text, isError) {
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'data') {
      state.app = m.app;
      state.curVersion = m.curVersion || '';
      if (m.manifest) state.manifest = m.manifest;
      applyResources();
      render();
    } else if (m.type === 'manifest') {
      // manifest 异步补全：只更新功能/依赖 tab 与右侧扩展资源，不整页重绘以免重刷 README
      if (m.manifest) state.manifest = m.manifest;
      if (m.resources) {
        state.resources = m.resources;
        applyResources();
      }
      renderNavbar();
      renderAdditional();
      bindAdditional();
    } else if (m.type === 'toast') {
      toast(m.text, m.isError);
    } else if (m.type === 'refresh') {
      post('getData');
    } else if (m.type === 'content') {
      // readme/changelog 等通过 ApiClient 获取（走代理/并发/重试），回调渲染。
      // 按 URL 追踪归属 tab：加载中切到其他 tab 不会把内容渲染到当前 tab，
      // 而是缓存到归属 tab，切回时直接显示，避免串台与重复请求
      var p = state.pendingContent[m.url];
      if (p) {
        var html = markdown(m.text || '', m.url);
        if (!m.text) {
          html = '<p class="nocontent">' + esc(p.noContent || '暂无内容。') + '</p>';
        }
        state.tabHtml[p.tab] = html;
        delete state.pendingContent[m.url];
        if (state.activeTab === p.tab) {
          var container = document.getElementById('content-container');
          if (container) {
            container.innerHTML = html;
            applyCachedImages(container);
          }
        }
      }
    } else if (m.type === 'image') {
      // 外部截图经扩展主机下载完成：以 base64 data URI 替换占位图
      if (m.url && m.dataUrl) {
        state.imageCache[m.url] = m.dataUrl;
        document.querySelectorAll('img[data-img-src="' + m.url + '"]').forEach(function (img) {
          img.removeAttribute('data-img-src');
          img.setAttribute('src', m.dataUrl);
        });
      } else if (m.url) {
        // 下载失败：替换为可见的“加载失败”占位，避免 1px 透明占位造成空白
        state.imageCache[m.url] = '';
        document.querySelectorAll('img[data-img-src="' + m.url + '"]').forEach(function (img) {
          img.removeAttribute('data-img-src');
          img.setAttribute('src', IMG_BROKEN);
          img.setAttribute('title', '图片加载失败');
        });
      }
    }
  });

  /** 将 manifest 补充的扩展资源合并到 app（data 重发后仍保留） */
  function applyResources() {
    var r = state.resources;
    if (!r || !state.app) return;
    if (r.repository) state.app.repository = r.repository;
    if (r.issues) state.app.issues = r.issues;
    if (r.moreInfoUrl) state.app.moreInfoUrl = r.moreInfoUrl;
    if (r.moreInfoLabel) state.app.moreInfoLabel = r.moreInfoLabel;
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

  function fromNow(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + ' 个月前';
    return Math.floor(diff / (86400 * 365)) + ' 年前';
  }

  function markdown(src, baseUrl) {
    if (!src) return '<div class="empty">无可用的自述文件。</div>';
    if (!md) return '<div class="empty">无可用的自述文件。</div>';
    mdRenderBaseUrl = baseUrl || '';
    var html = md.parse(String(src));
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html);
    }
    // 外部截图经扩展主机（代理/重试）下载后以 base64 data URI 展示：
    // webview <img> 由浏览器直连加载、不走本扩展配置的代理，受限网络下会加载失败
    html = proxyImages(html);
    return '<div class="markdown-body">' + html + '</div>';
  }

  var IMG_PLACEHOLDER =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // 下载失败时的可见占位（灰色破图图标 + 提示文字）
  var IMG_BROKEN =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='64'><rect width='96' height='64' fill='#f2f2f2'/><path d='M20 44 L34 30 L44 40 L56 28 L76 48' fill='none' stroke='#b0b0b0' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/><circle cx='34' cy='26' r='5' fill='#b0b0b0'/><text x='48' y='60' font-size='10' fill='#b0b0b0' text-anchor='middle' font-family='sans-serif'>图片加载失败</text></svg>"
    );

  // src 属性：兼容带引号/单引号/无引号（部分 README 原文为 <img src=https://... width=...> 无引号），
  // DOMPurify 净化时会把 & 转成 &amp;，需解码回原 URL 再下载
  var IMG_SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /** 将渲染后 HTML 中的外部 http(s) 图片替换为占位图，并请求扩展主机下载 */
  function proxyImages(html) {
    if (!html) return html;
    var out = html.replace(/<img\b[^>]*>/gi, function (tag) {
      var m = tag.match(IMG_SRC_RE);
      if (!m) return tag;
      var url = decodeEntities(m[1] || m[2] || m[3] || '');
      if (!/^https?:\/\//i.test(url)) return tag;
      var cached = state.imageCache[url];
      if (cached) {
        return tag.replace(IMG_SRC_RE, 'src="' + cached + '"');
      }
      if (state.imageCache[url] === undefined) {
        state.imageCache[url] = null;
        post('getImage', { url: url });
      }
      var noImg = tag.replace(/\s+data-img-src="[^"]*"/gi, '');
      // 在标签闭合符（> 或 />）之前插入 data-img-src，否则属性会落到标签外，
      // 既无法被 querySelector 匹配（图片永远不显示），又会在页面显示为可见文本
      noImg = noImg.replace(/\/?>$/, function (end) {
        return ' data-img-src="' + esc(url) + '"' + end;
      });
      return noImg.replace(IMG_SRC_RE, 'src="' + IMG_PLACEHOLDER + '"');
    });
    return out;
  }

  /** 用已缓存的 data URI 替换占位图（切 tab 后重新渲染时补图） */
  function applyCachedImages(root) {
    if (!root) return;
    root.querySelectorAll('img[data-img-src]').forEach(function (img) {
      var url = img.getAttribute('data-img-src');
      var cached = state.imageCache[url];
      if (cached) {
        img.removeAttribute('data-img-src');
        img.setAttribute('src', cached);
      }
    });
  }

  /** 相对路径转绝对路径：以 README/Changelog 内容 URL 为基准 */
  function toAbs(url, baseUrl) {
    if (!url) return '';
    if (/^(https?:|data:)/i.test(url) || url.charAt(0) === '#') return url;
    if (baseUrl) {
      try {
        return new URL(url, baseUrl).toString();
      } catch (e) {
        /* 忽略 */
      }
    }
    return url;
  }

  /* ---------------- Header：照抄 extensionEditor renderHeader ---------------- */

  function renderHeader(app) {
    var installed = !!app.installed;
    var updatable = installed && app.installedVersion && app.installedVersion !== app.version;
    var icon = app.icon
      ? '<img class="icon" src="' + esc(app.icon) + '" alt="">'
      : '<div class="icon">' + esc((app.displayName || app.name || '?').charAt(0).toUpperCase()) + '</div>';

    // title
    var title = '<span class="name">' + esc(app.displayName || app.name) + '</span>';
    // publisher + verified（照抄 PublisherWidget）
    var publisher = '';
    if (app.publisherDisplayName || app.publisher) {
      publisher =
        '<div class="subtitle-entry">' +
        '<div class="publisher">' +
        '<div class="publisher-name ellipsis">' + esc(app.publisherDisplayName || app.publisher) + '</div>' +
        (app.publisherVerified
          ? '<div class="verified-publisher"><span class="extension-verified-publisher clickable">&#10003;</span>' +
            (app.publisherDomain && app.publisherDomain.link
              ? '<span class="extension-verified-publisher-domain">' + esc(app.publisherDomain.link.replace(/^https?:\/\/(www\.)?/, '')) + '</span>'
              : '') +
            '</div>'
          : '') +
        '</div>' +
        '</div>';
    }
    // install count（照抄 InstallCountWidget：非 small 用 toLocaleString）
    var installEntry = '';
    if (app.downloadCount > 0) {
      installEntry =
        '<div class="subtitle-entry"><span class="install"><span class="count">' +
        Number(app.downloadCount).toLocaleString() +
        '</span></span></div>';
    }
    // rating（照抄 RatingsWidget：5 星 + count）
    var ratingEntry = '';
    if (app.rating > 0) {
      var rating = Math.round(app.rating * 2) / 2;
      var stars = '';
      for (var i = 1; i <= 5; i++) {
        if (rating >= i) stars += '<span class="codicon">&#9733;</span>';
        else if (rating >= i - 0.5) stars += '<span class="codicon">&#9733;</span>';
        else stars += '<span class="codicon">&#9734;</span>';
      }
      ratingEntry =
        '<div class="subtitle-entry"><span class="rating">' + stars +
        (app.ratingCount ? '<span style="padding-left:1px"> (' + app.ratingCount + ')</span>' : '') +
        '</span></div>';
    }

    var subtitle = publisher + installEntry + ratingEntry;

    // actions-status-container（照抄 ActionBar）
    var actions = '';
    if (installed) {
      if (updatable) {
        actions += '<span class="extension-action label update" data-act="update">更新</span>';
      }
      actions += '<span class="extension-action label uninstall" data-act="uninstall">卸载</span>';
      actions += '<span class="extension-action label" data-act="selectVersion">安装特定版本...</span>';
      // Auto Update checkbox（照抄 ToggleAutoUpdateForExtensionAction）
      actions +=
        '<label class="checkbox-action-item"><input type="checkbox" data-act="toggleAutoUpdate"' +
        (app.autoUpdate ? ' checked' : '') + '><span class="auto-update-label">自动更新</span></label>';
    } else if (app.hasPackage) {
      actions += '<span class="extension-action label prominent install" data-act="install">安装</span>';
    }

    var description = app.description
      ? '<div class="description">' + esc(app.description) + '</div>'
      : '';

    return (
      '<div class="header">' +
      '<div class="icon-container"><div class="extension-icon">' + icon + '</div></div>' +
      '<div class="details">' +
      '<div class="title">' + title + '</div>' +
      (subtitle ? '<div class="subtitle">' + subtitle + '</div>' : '') +
      description +
      (actions ? '<div class="actions-status-container"><div class="actions-container">' + actions + '</div></div>' : '') +
      '</div>' +
      '</div>'
    );
  }

  /* ---------------- Additional Details：照抄 AdditionalDetailsWidget ---------------- */

  function renderAdditionalDetails(app) {
    var html = '<div class="additional-details-content">';

    // Marketplace Info（照抄 renderMarketplaceInfo）→ 详细信息（自上而下第一个）
    var moreInfo = '';
    if (!app.installed) {
      moreInfo +=
        '<div class="more-info-entry"><div class="more-info-entry-name">标识符</div><code>' + esc(app.id) + '</code></div>';
      if (app.version) {
        moreInfo +=
          '<div class="more-info-entry"><div class="more-info-entry-name">版本</div><code>' + esc(app.version) + '</code></div>';
      }
    }
    if (app.releaseDate) {
      moreInfo +=
        '<div class="more-info-entry"><div class="more-info-entry-name">发布日期</div><div title="' + esc(app.releaseDate) + '">' + fromNow(app.releaseDate) + '</div></div>';
    }
    if (app.lastUpdated) {
      moreInfo +=
        '<div class="more-info-entry"><div class="more-info-entry-name">最后发布</div><div title="' + esc(app.lastUpdated) + '">' + fromNow(app.lastUpdated) + '</div></div>';
    }
    if (moreInfo) {
      html +=
        '<div class="more-info-container additional-details-element">' +
        '<div class="additional-details-title">详细信息</div>' +
        '<div class="more-info">' + moreInfo + '</div></div>';
    }

    // Categories → 类别
    if (app.categories && app.categories.length) {
      html +=
        '<div class="categories-container additional-details-element">' +
        '<div class="additional-details-title">类别</div>' +
        '<div class="categories">' +
        app.categories.map(function (c) { return '<span class="category clickable" data-category="' + esc(c) + '">' + esc(c) + '</span>'; }).join('') +
        '</div></div>';
    }

    // Resources（照抄 renderExtensionResources：Repository/Issues/License/MoreInfo）→ 扩展资源
    // repository/issues/moreInfo 由 manifest 补充（resolveResources），对齐 VS Code 展示
    var resources = [];
    if (app.repository) resources.push(['仓库', app.repository]);
    if (app.issues) resources.push(['Issues', app.issues]);
    if (app.licenseUrl) resources.push(['许可证', app.licenseUrl]);
    if (app.moreInfoUrl) resources.push([app.moreInfoLabel || '应用商店', app.moreInfoUrl]);
    if (resources.length) {
      html +=
        '<div class="resources-container additional-details-element">' +
        '<div class="additional-details-title">扩展资源</div>' +
        '<div class="resources">' +
        resources.map(function (r) {
          return '<div class="resource"><a href="' + esc(r[1]) + '" target="_blank" title="' + esc(r[1]) + '">' + esc(r[0]) + '</a></div>';
        }).join('') +
        '</div></div>';
    }

    html += '</div>';
    return html;
  }

  /* ---------------- Navbar（照抄 NavBar） ---------------- */

  function buildNavbar(app, manifest) {
    var tabs = [{ id: 'Details', label: '细节' }];
    if (manifest) {
      tabs.push({ id: 'Features', label: '功能' });
    }
    if (app.changelogUrl) {
      tabs.push({ id: 'Changelog', label: '更改日志' });
    }
    var deps = getDependencies(manifest);
    if (deps.length) {
      tabs.push({ id: 'Dependencies', label: '依赖项' });
    }
    var pack = getExtensionPack(manifest);
    if (pack.length) {
      tabs.push({ id: 'ExtensionPack', label: '扩展包' });
    }
    return tabs;
  }

  function getDependencies(manifest) {
    if (!manifest || !manifest.extensionDependencies) return [];
    return manifest.extensionDependencies;
  }

  function getExtensionPack(manifest) {
    if (!manifest || !manifest.extensionPack) return [];
    return manifest.extensionPack;
  }

  /* ---------------- Features（照抄 ExtensionFeaturesTab 逻辑，从 manifest.contributes 解析） ---------------- */

  function buildFeatures(manifest) {
    if (!manifest || !manifest.contributes) return [];
    var c = manifest.contributes;
    var features = [];

    if (c.commands && c.commands.length) {
      features.push({ id: 'commands', label: '命令', data: c.commands.map(function (cmd) {
        return { command: cmd.command || '', title: (cmd.title && cmd.title.value) || cmd.title || '', category: (cmd.category && cmd.category.value) || cmd.category || '' };
      }) });
    }
    if (c.keybindings && c.keybindings.length) {
      features.push({ id: 'keybindings', label: '键绑定', data: c.keybindings });
    }
    if (c.menus && Object.keys(c.menus).length) {
      var menus = [];
      Object.keys(c.menus).forEach(function (where) {
        (c.menus[where] || []).forEach(function (m) {
          menus.push({ where: where, command: m.command || '', when: m.when || '', group: m.group || '' });
        });
      });
      features.push({ id: 'menus', label: '菜单', data: menus });
    }
    if (c.configuration) {
      var cfg = [];
      var confs = Array.isArray(c.configuration) ? c.configuration : [c.configuration];
      confs.forEach(function (conf) {
        if (!conf || !conf.properties) return;
        Object.keys(conf.properties).forEach(function (key) {
          cfg.push({ key: key, type: conf.properties[key].type || '', description: (conf.properties[key].description && conf.properties[key].description.value) || conf.properties[key].description || '' });
        });
      });
      if (cfg.length) features.push({ id: 'configuration', label: '配置', data: cfg });
    }
    if (c.languages && c.languages.length) {
      features.push({ id: 'languages', label: '语言', data: c.languages.map(function (l) { return { id: l.id || '', extensions: (l.extensions || []).join(', ') }; }) });
    }
    if (c.viewsContainers) {
      var vc = [];
      Object.keys(c.viewsContainers).forEach(function (loc) {
        ((c.viewsContainers[loc] && c.viewsContainers[loc].containers) || []).forEach(function (v) {
          vc.push({ id: v.id || '', title: (v.title && v.title.value) || v.title || '', location: loc });
        });
      });
      if (vc.length) features.push({ id: 'viewsContainers', label: '视图容器', data: vc });
    }
    if (c.views) {
      var views = [];
      Object.keys(c.views).forEach(function (loc) {
        ((c.views[loc] || [])).forEach(function (v) {
          views.push({ id: v.id || '', name: (v.name && v.name.value) || v.name || '', location: loc });
        });
      });
      if (views.length) features.push({ id: 'views', label: '视图', data: views });
    }
    if (c.themes && c.themes.length) {
      features.push({ id: 'themes', label: '主题', data: c.themes.map(function (t) { return { id: t.id || '', label: (t.label && t.label.value) || t.label || '', uiTheme: t.uiTheme || '' }; }) });
    }
    return features;
  }

  function featureRows(feature) {
    var rows = feature.data || [];
    if (feature.id === 'commands') {
      return '<table><tr><th>命令</th><th>标题</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.command) + '</code></p></td><td><p>' + esc(r.title + (r.category ? ' (' + r.category + ')' : '')) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'keybindings') {
      return '<table><tr><th>键绑定</th><th>命令</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.key || '') + '</code></p></td><td><p><code>' + esc(r.command || '') + '</code></p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'menus') {
      return '<table><tr><th>命令</th><th>位置</th><th>条件</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.command) + '</code></p></td><td><p>' + esc(r.where) + '</p></td><td><p>' + esc(r.when) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'configuration') {
      return '<table><tr><th>键</th><th>类型</th><th>描述</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.key) + '</code></p></td><td><p>' + esc(r.type) + '</p></td><td><p>' + esc(r.description) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'languages') {
      return '<table><tr><th>Id</th><th>扩展</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.id) + '</code></p></td><td><p>' + esc(r.extensions) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'viewsContainers') {
      return '<table><tr><th>Id</th><th>标题</th><th>位置</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.id) + '</code></p></td><td><p>' + esc(r.title) + '</p></td><td><p>' + esc(r.location) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'views') {
      return '<table><tr><th>Id</th><th>名称</th><th>位置</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.id) + '</code></p></td><td><p>' + esc(r.name) + '</p></td><td><p>' + esc(r.location) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    if (feature.id === 'themes') {
      return '<table><tr><th>Id</th><th>标签</th><th>UI 主题</th></tr>' +
        rows.map(function (r) { return '<tr><td><p><code>' + esc(r.id) + '</code></p></td><td><p>' + esc(r.label) + '</p></td><td><p>' + esc(r.uiTheme) + '</p></td></tr>'; }).join('') +
        '</table>';
    }
    return '<div class="empty">无数据。</div>';
  }

  /* ---------------- 主渲染 ---------------- */

  function render() {
    var app = state.app;
    if (!app) return;
    document.body.innerHTML =
      '<div class="extension-editor">' +
      renderHeader(app) +
      '<div class="body">' +
      '<div class="navbar"><div class="actions-container"></div></div>' +
      '<div class="content">' +
      '<div class="details">' +
      '<div class="content-container" id="content-container"></div>' +
      '<div class="additional-details-container"></div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';

    renderNavbar();
    renderAdditional();
    bindActions();
    openTab(state.activeTab);
  }

  /** 仅重建 navbar（manifest 异步到达时补充功能/依赖 tab，不整页重绘以免重刷 README） */
  function renderNavbar() {
    var nav = document.querySelector('.navbar .actions-container');
    if (!nav) return;
    var tabs = buildNavbar(state.app, state.manifest);
    nav.innerHTML = tabs
      .map(function (t) {
        return '<div class="action-item" data-tab="' + t.id + '"><span class="action-label' + (t.id === state.activeTab ? ' checked' : '') + '">' + esc(t.label) + '</span></div>';
      })
      .join('');
    bindNavbar();
  }

  function bindNavbar() {
    document.querySelectorAll('.navbar .action-item').forEach(function (item) {
      item.addEventListener('click', function () {
        document.querySelectorAll('.navbar .action-item .action-label').forEach(function (x) { x.classList.remove('checked'); });
        var label = item.querySelector('.action-label');
        if (label) label.classList.add('checked');
        state.activeTab = item.getAttribute('data-tab');
        openTab(state.activeTab);
      });
    });
  }

  /** 仅重建右侧附加详情（详细信息/类别/扩展资源） */
  function renderAdditional() {
    var c = document.querySelector('.additional-details-container');
    if (!c) return;
    c.innerHTML = renderAdditionalDetails(state.app);
  }

  function bindAdditional() {
    // category 点击 → 打开主面板搜索
    document.querySelectorAll('.category[data-category]').forEach(function (c) {
      c.addEventListener('click', function () {
        post('openCategory', { category: c.getAttribute('data-category') });
      });
    });
  }

  // 操作按钮
  function bindActions() {
    document.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        if (b.getAttribute('data-act') === 'toggleAutoUpdate') {
          ev.preventDefault();
          post('toggleAutoUpdate');
          return;
        }
        var act = b.getAttribute('data-act');
        if (act === 'install') post('install');
        else if (act === 'update') post('update');
        else if (act === 'uninstall') post('uninstall');
        else if (act === 'selectVersion') post('selectVersion');
      });
    });
  }

  function openTab(id) {
    var container = document.getElementById('content-container');
    if (!container) return;
    container.innerHTML = '<div class="spinner"></div>';
    var app = state.app;
    var manifest = state.manifest;
    var features = buildFeatures(manifest);

    if (id === 'Details') {
      if (state.tabHtml.Details) {
        container.innerHTML = state.tabHtml.Details;
        applyCachedImages(container);
        return;
      }
      loadMarkdown(container, app.readmeUrl, '无可用的自述文件。', 'Details');
    } else if (id === 'Changelog') {
      if (state.tabHtml.Changelog) {
        container.innerHTML = state.tabHtml.Changelog;
        applyCachedImages(container);
        return;
      }
      loadMarkdown(container, app.changelogUrl, '无可用的更改日志。', 'Changelog');
    } else if (id === 'Features') {
      renderFeaturesTab(container, features);
    } else if (id === 'Dependencies') {
      renderExtensionsList(container, getDependencies(manifest), '没有依赖项');
    } else if (id === 'ExtensionPack') {
      renderExtensionsList(container, getExtensionPack(manifest), '没有扩展');
    }
  }

  function loadMarkdown(container, url, noContent, tabId) {
    if (!url) {
      container.innerHTML = '<p class="nocontent">' + esc(noContent) + '</p>';
      return;
    }
    if (state.pendingContent[url]) {
      // 该 URL 已在加载中：仅更新归属 tab（切走再切回不重复请求）
      state.pendingContent[url].tab = tabId;
      state.pendingContent[url].noContent = noContent;
      return;
    }
    container.innerHTML = '<div class="spinner"></div>';
    // 通过 ApiClient 获取（走代理/并发/重试），避免 webview fetch 直连 open-vsx 不稳定
    state.pendingContent[url] = { tab: tabId, noContent: noContent };
    post('getContent', { url: url });
  }

  /* Features tab：可折叠分组（对齐 VS Code ExtensionFeaturesTab：details/summary，点标题展开/收起） */
  function renderFeaturesTab(container, features) {
    if (!features.length) {
      container.innerHTML = '<p class="nocontent">未贡献任何功能。</p>';
      return;
    }
    var html = '<div class="subcontent feature-contributions">';
    features.forEach(function (f, i) {
      html +=
        '<details' + (i === 0 ? ' open' : '') + '>' +
        '<summary>' + esc(f.label) + '</summary>' +
        '<div class="feature-body-content"><div class="feature-content">' + featureRows(f) + '</div></div>' +
        '</details>';
    });
    html += '</div>';
    container.innerHTML = html;
  }

  /* Dependencies / ExtensionPack：照抄 ExtensionsTree 列表 */
  function renderExtensionsList(container, ids, noContent) {
    if (!ids.length) {
      container.innerHTML = '<p class="nocontent">' + esc(noContent) + '</p>';
      return;
    }
    var html = '<div class="subcontent">' +
      ids.map(function (id) {
        return '<div class="extension" data-id="' + esc(id) + '">' +
          '<div class="icon">&#128230;</div>' +
          '<div class="details">' +
          '<div class="header"><span class="name">' + esc(id) + '</span></div>' +
          '<div class="footer"><span class="publisher">' + esc(id.split('.')[0] || '') + '</span></div>' +
          '</div></div>';
      }).join('') +
      '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.extension[data-id]').forEach(function (el) {
      el.addEventListener('click', function () {
        post('openApp', { id: el.getAttribute('data-id') });
      });
    });
  }
})();
