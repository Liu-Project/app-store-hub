# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.23] - 2026-10-30

### 新增

- **中英文界面切换**：新增配置 `appStoreHub.language`（`auto` 跟随 VS Code 界面语言 / `zh-cn` / `en`），列表、详情页与扩展端提示（QuickPick、进度、toast、错误信息）全部走语言包。
  - 新增 `src/i18n.ts`（扩展端 zh/en 字典与 `t()`）、`webview/i18n.js`（webview 端 `window.t()` 字典），`getHtml` 注入 `__APPSTORE_LOCALE__`。
  - 新增 `tests/unit/i18n.test.ts`（语言切换/占位符/未知 key 回退），webview 冒烟测试补充 i18n.js 初始化、英文切换与 key 完整性校验。
- **英文版 README（README.en.md）**，中文 README 补齐 GitHub Stars / CI 徽章与语言切换入口。

### 修复

- **「Webview is disposed」未捕获错误刷屏**：详情面板/侧边栏视图被关闭后，异步回调仍向已销毁的 webview 发消息。
  - 扩展端：新增 `src/safePost.ts` 统一吞掉已销毁 webview 的同步/异步发送异常，`appStoreHubPanel`/`detailPanel` 全部 `postMessage` 调用点改用 `safePost`。
  - webview 端：`appStoreHub.js` 的 `request`/`log` 与 `detail.js` 的 `post` 统一 try/catch 包裹 `vscode.postMessage`，页面销毁后异步回调不再抛未捕获错误。

## [0.1.22] - 2026-10-27

### 修复

- **列表一直「正在加载应用列表」**：`state.view` 初始为 `'list'`，而 `loadApps` 仅在 `view === 'market'` 时渲染，数据成功返回后被静默跳过。已改为初始 `'market'`（对齐 VS Code 默认打开市场视图）。
- **详情页打不开（Details tab 永远转圈）**：`getContent`（readme/changelog）失败时只弹 toast 不回 webview，`pendingContent` 永不 resolve。已改为失败也回空内容，显示「无可用的自述文件。」而非无限 spinner；`getVersions` 失败静默，不回空数组以免清空已展示版本。
- **详情页截图刷新不出来（VS Code Marketplace / Open VSX 均受影响）**：README 中外部截图由 webview `<img>` 浏览器直连加载、不走本扩展代理，受限网络下加载失败。已改为经扩展主机（ApiClient/netHttp，带代理/并发赛跑/重试）下载后以 base64 data URI 回传展示。
  - **核心回归**：`proxyImages` 用 `+=` 把 `data-img-src` 追加到 img 标签字符串末尾，对非自闭合 `<img>` 属性落到**标签外**，导致 `image` 消息回来时 `querySelectorAll('img[data-img-src]')` 匹配不到（图片永不替换）且页面出现可见的 `data-img-src="..."` 文本。已改为替换闭合符（`>/>`）前插入属性。
  - `src` 匹配兼容**无引号**形式（`<img src=https://... width=...>`，如 ms-python 官方 README），并解码 DOMPurify 转义的 `&amp;` 等实体，避免下载 URL 失真。
  - `github.com/{o}/{r}/raw/{ref}/{path}` 自动改写为 `raw.githubusercontent.com` 直连，跳过易挂起的 github.com 重定向跳板。
  - 图片下载提高并发（8）并缩短单连接超时上限（6s）：命中成功连接更快（实测 24KB GIF 由 ~21s 降至 ~0.6s），失败更早淘汰；下载失败时显示可见的「图片加载失败」占位，而非 1px 空白。
  - **大 GIF（动态图）加载加速**：图片下载并发提升至 8、单连接超时上限 6s（仅覆盖连接建立，传输不受限）；新增扩展主机侧会话级图片缓存（最多 200 张，github.com/raw 与 raw.githubusercontent.com 归一化共享），再次打开详情时 README 图片直接命中缓存毫秒级显示，无需重新经代理下载。
- **切走插件中心再切回，搜索词被清空**：`setViewState` 用 `cfg.update` 写入未注册的 `appStoreHub.viewState` 配置，VS Code 报「没有注册配置」导致保存失败；侧边栏 WebviewView 切走再切回会重载脚本，恢复不到搜索词。已改为写入扩展 `globalState`（Memento），`getViewState`/`setViewState` 均改用它，搜索词/分页/筛选在重载后完整恢复。
- **移除详情页「版本历史」tab**：删除 `webview/detail.js` 的 `renderVersions`/Versions tab/`getVersions` 请求、`detailPanel.ts` 的 `getVersions` 消息处理、`apiClient.getVersionsList` 及 `GALLERY_FLAGS_VERSIONS`、`detail.css` 版本历史样式。

### 新增

- `netHttp.httpRequest` 支持 `binary` 选项（响应体以 base64 返回），`ApiClient.getImageDataUrl` 获取外部图片并转 data URI。
- `webview/detail.js` 图片代理链路：`proxyImages` 将外部 http(s) 图片替换为占位图并发起 `getImage` 请求，`image` 消息回填 base64，失败 URL 缓存为空不重试。
- `webview-smoke.test.ts` 新增图片代理回归断言：`data-img-src` 必须插入 img 标签内、`src` 匹配兼容无引号形式。

## [0.1.21] - 2026-10-27

### 修复

- **插件中心面板一片黑**：webview/appStoreHub.js 首行被误改为 `ctrl(function () {`，`ctrl` 未定义导致整个 webview 脚本运行时崩溃（`ReferenceError`），面板空白且无任何日志。已恢复为正确的 IIFE `(function () {`。

### 测试

- 新增 `tests/unit/webview-smoke.test.ts` 冒烟测试：在最小 DOM 沙箱中执行 appStoreHub.js / detail.js，断言 IIFE 首尾完整、初始化无异常且能发起消息，防止 webview 再次白屏。

## [0.1.20] - 2026-10-27

### 修复

- 插件激活时立即创建「插件中心」输出通道（此前惰性创建，未打开插件中心面板时输出面板中找不到该通道）。

## [0.1.19] - 2026-10-27

### 新增

- **调试日志**：完整请求链路日志（软件源 URL、代理、连接方式、HTTP 状态、耗时、重试与错误详情）写入「插件中心」输出面板。
  - 配置 `appStoreHub.debug`（默认开启），或命令面板执行 **「插件中心：切换插件中心调试日志」** 快速开关（Ctrl+Shift+P）。
  - 关闭调试日志后，错误日志仍会输出（便于定位问题）。
  - webview 端日志（加载流程各阶段）通过消息转发到同一输出面板。

## [0.1.18] - 2026-10-27

### 修复

- **软件源（VS Code Marketplace / Open VSX）一直「正在加载应用列表」**：根因是 VS Code 从桌面图标启动时扩展进程不继承终端导出的代理环境变量，插件直连软件源全部超时。现对齐 VS Code 内置扩展商城的代理机制：
  - 新增配置 `appStoreHub.proxy`，代理解析优先级：`appStoreHub.proxy` > `http.proxy`（VS Code 标准设置）> 环境变量 `https_proxy`/`http_proxy` 等。
  - 所有请求（列表/详情/README/manifest/VSIX 下载）统一走该代理，`downloadFile` 同样支持。
  - 连接失败时错误信息明确提示配置代理。

## [0.1.17] - 2026-10-27

### 修复

- **open-vsx 源加载失败**：连接超时默认值 8000ms → 20000ms。open-vsx 经代理响应可达 10~15s，原 8s 的 socket idle 超时会在数据到达前误杀连接，导致重试 5 次全部失败并提示「无法连接软件源」。

## [0.1.16] - 2026-10-27

### 变更

- 详情页**完全照抄 VS Code 1.138.0 内置扩展商城源码**（多软件源 / 版本历史 / 卡片列表自研保留，其余全部对齐）：
  - **Header**：128px 图标 + 标题 + 发布者（含已验证域名徽章）+ 安装量（千分位）+ 星级评分 + 描述 + 操作按钮区（安装 / 更新 / 卸载 / 安装特定版本 + **Auto Update 复选框**）。
  - **Navbar tabs**：Details（说明）/ Features（功能）/ Changelog（更改日志）/ Dependencies（依赖项）/ Extension Pack（扩展包）/ Version History（版本历史，自研保留）。
  - **Features tab**：按 VS Code `ExtensionFeaturesTab` 逻辑从 manifest `contributes` 解析（Commands / Keybindings / Menus / Configuration / Languages / Views / Themes 等），左侧功能列表 + 右侧表格视图。
  - **Dependencies / Extension Pack tab**：从 manifest `extensionDependencies` / `extensionPack` 渲染列表，点击打开对应扩展详情。
  - **Additional Details（右侧栏）**：Categories（可点击回主面板分类过滤）、Resources（Repository / Issues / License / Marketplace）、Marketplace Info（Identifier / Version / Published / Last Released）。
- **Auto Update 开关**：切换调用 VS Code 内置命令 `workbench.extensions.action.toggleAutoUpdateForExtension`（源无关，写入本地 storage）；勾选状态读取 `extensions.autoUpdate` 配置近似显示。
- **README / Changelog / manifest 获取改为 ApiClient**：走当前软件源配置的代理 / 并发 / 重试策略（open-vsx 并发赛跑、微软顺序重试），不再由 webview 直连 fetch，解决 open-vsx 不稳定导致的加载失败。
- ApiClient 新增通用 `getJson` / `getText`（绝对 URL，配置驱动的并发与重试），manifest 获取复用 `concurrentEnabled()` 按源配置决定是否并发。

## [0.1.12] - 2026-10-27

### 变更

- 详情页布局**完全对齐 VS Code 内置市场**：顶部横向 header（左侧 96px 图标 + 中间信息区：标题/验证徽章、发布者·版本·更新时间、描述、分列统计（下载量/评分/更新日期）、分类、标签、资源链接 + 右上角操作按钮列），下方为「说明 / 更新日志 / 版本历史」tabs 与内容区。**版本历史 tab 完整保留**。

## [0.1.11] - 2026-10-27

### 新增

- 已安装视图**显示扩展图标**（本地扩展的 package.json.icon 通过 webview 资源根加载，无图标时显示首字母占位）。
- 已安装视图**显示启用/禁用状态徽章**（启用=绿色徽章，已禁用=灰色徽章并置灰整行），按钮随状态切换为「禁用」/「启用」。

### 变更

- 应用市场卡片**移除齿轮按钮**：安装/更新/卸载、选择与下载历史版本统一收敛到详情页，卡片仅保留「安装」「更新」按钮与状态徽章，点击卡片进入详情。
- 详情页布局**对齐 VS Code 内置市场**：改为左侧信息栏（图标、标题、发布者、操作按钮、评分/下载量、描述、分类、标签、资源链接）与右侧内容区（说明/更新日志/版本历史 tab）分栏，窄屏自动回退为纵向布局；**版本历史 tab 保留**。

## [0.1.10] - 2026-10-27

### 新增

- **视图下拉**（对齐 VS Code 扩展视图顶部）：热门（默认，按相关度/安装量）、最近更新（按更新时间），切换即时重新加载。
- **筛选与排序漏斗**：排序（相关度/安装量/评分/名称/最近更新）、分类（来自当前软件源）、搜索过滤器（已安装/内置）。全部映射为 Gallery 协议标准参数（`sortBy`/`sortOrder`/`filterType:5` 分类/`filterType:10` 搜索词）。
- 搜索 **@ 语法扩展**：新增 `@sort:installs|rating|name|updated`、`@tag:xxx`、`@enabled`、`@disabled`，与已有的 `@installed`/`@builtin`/`@category:` 组合使用。
- 应用卡片**「更新可用」徽章**：已安装且市场有新版本时在卡片右上角显示并切换为「更新」按钮。
- 已安装视图**「已禁用」标记**：通过对比磁盘 `extensions.json` 与 `vscode.extensions.all` 判定禁用状态并置灰显示。
- 管理（齿轮）菜单新增**「复制扩展 ID」**。
- 详情页增强：发布者显示名、**已验证发布者徽章**（Gallery `isDomainVerified`/`isVerified`）、标签（#tags）、资源链接（更多信息/仓库/问题跟踪，Gallery `moreInfoUrl`/`repository`/`issues`，缺失时自动隐藏）。

### 说明

- 「精选(Featured)」与「趋势(Trending)」视图**未实现**：实测微软 Marketplace 的 `filterType:7` 实为扩展全名查询（非精选），open-vsx 对 `filterType:7` 返回空——标准 Gallery 协议无法表达精选，为保持多源协议兼容而省略。
- 排序严格遵循 Gallery `sortBy` 枚举（0=相关度 1=最近更新 2=安装量 3=名称 6=评分）。实测 open-vsx 对 sortBy 0/1/2 返回相同结果（源未区分排序），评分排序有效；微软官方市场支持完整排序。源不支持时返回其默认排序，不报错。

## [0.1.9] - 2026-10-27

### 修复

- 修复「应用市场」与「已安装」视图切换时的异步竞态：切走视图后，迟到的市场/已安装请求结果不再覆盖当前视图内容。

## [0.1.8] - 2026-10-27

### 新增

- 本地已安装扩展管理：「已安装」视图标签页，展示全部已安装扩展（名称/发布者/版本/简介/内置标记），支持**禁用/启用**与**卸载**（操作后需重新加载窗口生效），支持按名称/发布者/描述过滤。
- 搜索 **@ 语法**（对齐 VS Code）：`@installed`（仅显示已安装，自动切换到「已安装」视图）、`@builtin`（已安装视图中仅显示内置扩展）、`@category:<分类>`（按分类过滤市场列表）。
- 软件源级**并发开关**：设置项 `appStoreHub.sources` 每个源可配置 `concurrent` 字段（默认微软市场关闭、Open VSX 开启），控制首次连接失败后是否并发赛跑。
- 发布脚本 `scripts/release.cjs`：一键 `patch` / `minor` / `major` 或指定版本号，自动更新 `package.json` 版本并打包至 `releases/`。

### 变更

- 详情页全面对齐 VS Code 原生商店：重写为 `createWebviewPanel` 独立面板，采用 VS Code 主题变量（自动适配明暗主题），含「说明 / 更新日志 / 版本历史」三个页签、迷你 Markdown 渲染、版本历史中可安装/下载指定版本。
- 应用卡片与详情页均展示**评分（★）与下载量**（K/M 缩写）。

### 修复

- Jupyter Keymap 等扩展查不到历史版本：微软市场 `filterType:7` 必须传完整 `publisher.extension` 全名，混用 `filterType:1` 会返回 HTTP 400；应用 ID 统一改为 `publisher.extensionName`。
- 当前已安装版本在详情页「版本历史」中不可见/不可下载（已安装判断逻辑仅应用于安装分支）。
- 齿轮菜单响应慢：`fetchAll` 改用列表级 `GALLERY_FLAGS_LIST`（不再携带版本详情）、应用信息 5 分钟缓存、降级后按全名重查。

## [0.1.6] - 2026-10-27

### 新增

- **无限滚动**：应用列表滚动到底部自动加载下一页（IntersectionObserver），卡片布局对齐 VS Code 原生市场（未安装=安装按钮+齿轮菜单，已安装=仅齿轮菜单）。
- 齿轮菜单收敛安装/更新/卸载/切换版本/下载 VSIX 等全部管理操作。

## [0.1.5] - 2026-10-27

### 新增

- 视图状态持久化：搜索词、软件源、页码等保存在全局配置 `appStoreHub.viewState`，切换视图/重启后自动恢复（配合 `retainContextWhenHidden`）。

### 修复

- 修复切换软件源后搜索词未保留的问题。

## [未发布]

### 新增

- 插件更名：`插件中心（appStoreHub）`，内部标识统一为 `appStoreHub.*`。
- 预置 VS Code 官方 Marketplace 与 **Open VSX** 软件源。
- `netHttp` 支持 HTTP 重定向跟随（301/302/303/307/308），兼容 Open VSX CDN 下载。
- 引入 ESLint + Prettier 代码规范与格式化。
- 引入 Mocha 单元测试框架，覆盖 `netHttp` / `apiClient` / `config`。
- 新增 GitHub Actions CI 工作流（lint / compile / test / package）。
- 补充开源配套文档：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`.editorconfig`。

### 变更

- 仓库仅保留插件本体，本地后端移出版本库。
- 完善 `tsconfig.json` 严格编译选项（`noUnusedLocals` 等）。
- 规范化 `package.json` 元数据与脚本。
- 软件源配置补充「名称(label)」与「地址(url)」字段提示：设置项 `appStoreHub.sources` 描述说明每个条目需包含名称和地址（地址以 http:// 或 https:// 开头），软件源管理弹窗同步提示字段含义。

### 修复

- 连接软件源失败时自动重试（默认最多 5 次尝试），解决 Open VSX 经代理约 60% 概率连接被中断导致的"无法连接软件源（连接超时）"问题；可通过新增的 `appStoreHub.retry` 配置调整重试次数，写操作（安装/卸载/更新）不重试。
- 单次请求连接超时缩短为 8 秒（`appStoreHub.connTimeout` 可调），让代理挂起场景更快失败进入重试；前端请求等待超时提升至 60 秒，与后端重试最坏耗时对齐，避免"搜索成功后又报 getApps 超时"。
- 连接重试改为**并发赛跑**：同一轮同时发起最多 3 个连接，首个成功立即返回并取消其余连接（`AbortSignal` 支持），失败则进入下一轮；实测最慢场景由约 16.6s 降至 9s、平均由 3.3s 降至 2.1s。
- 切换软件源时**保留搜索词**：例如在 Open VSX 搜索 markdown 后切到微软市场，直接用 markdown 在新源重新搜索，无需重新输入。
- 并发策略调整为**首连成功后不再并发**：首次始终单连接，仅当连接失败（如 open-vsx 断连）后才并发赛跑，避免稳定源（微软市场）每次操作发多个请求而触发微软 IP Rate Limit（"Request was blocked due to exceeding usage of resource 'Count' in namespace 'IPAddress'"）。

## [0.1.0] - 2026-10-26

### 新增

- 富界面插件市场：应用卡片网格、关键字搜索（防抖）、分页。
- 独立详情页（`createWebviewPanel`），支持 README / 更新日志渲染。
- 安装 / 卸载 / 更新 / 切换版本，支持 `auto` / `manual` 两种安装模式。
- 多软件源管理（添加 / 删除 / 切换）。
- VS Code Gallery 协议对接与原生 socket HTTP 客户端。
