# Changelog

All notable changes to this project will be documented in this file.

## [0.2.11] - 2026-11-03

### Added

- 预览中的未知 / 自定义 XML 标签（如 `<Schedules>`、`<Schedule ...>`、`<PartitionWindow/>`）改为以 Typora 风格的低对比度灰色文本显示（标签名与属性均可见），不再被浏览器当作自定义元素吞掉而完全隐藏；保留原有换行与缩进，正文颜色不受影响。标准 HTML 标签（`<img>`、`<table>`、`<div>` 等）仍保持真实渲染。自定义编辑器预览与 VS Code 内置 Markdown 预览（Ctrl+K V）两条链路均生效。

## [0.2.10] - 2026-10-30

### Fixed

- 修复预览不随编辑实时更新的问题：预览以带唯一 query 的 URI 打开，VS Code 会为它单独创建一个只读快照 TextDocument；编辑器中修改文件后预览仍渲染旧内容（如删除列表项后预览仍显示该项）。现在改为从用户正在编辑的真实文档（无 query 的 URI）重新渲染，并在保存时也刷新，行为与 VS Code 内置 Markdown 预览一致。

## [0.2.9] - 2026-10-16

### Added

- 预览标签页使用专属图标（文档 + 放大镜），与普通 Markdown 文件标签区分。

### Changed

- 预览打开位置调整：资源管理器 / 编辑器标签页右键"Open with CommonMark Preview"改为在当前活动窗口内打开预览（与该文件堆叠），不再弹出并排新窗口；右上角图标与 `Ctrl+K K` 仍为并排打开。任一入口打开时，若对应窗口已存在该文件的预览则直接激活它，不重复新建（与 VS Code 内置预览行为一致）。

### Fixed

- 修复滚动联动误触发：当预览与源文件在同一窗口堆叠时（如右键打开预览且文件已打开），编辑器的滚动不再反向拖动隐藏的预览，切换回预览时位置保持不变；滚动联动仅在预览与源编辑器并排（不同编辑组）时生效。
- 修复多窗口联动只跟随最左侧编辑器的问题：滚动预览时，所有并排打开同一文件的编辑器会一起滚动（与 VS Code 内置预览行为一致）。

## [0.2.7] - 2026-10-16

### Added

- 预览与编辑自定义编辑器支持搜索：为 `markdown-commonmark-preview.preview` / `.editor` 的 Webview 启用 `enableFindWidget`，在预览中按 `Ctrl+F`（Mac 为 `Cmd+F`）即可打开与 VS Code 内置 Markdown 预览一致的查找控件（上一个 / 下一个、匹配高亮与计数、回车切换、`Esc` 关闭）。

## [0.2.6] - 2026-10-15

### Fixed

- 修复插件激活时报错的问题：`contributes.colors` 中 4 个颜色 id 原先包含连字符 `-`（如 `markdown-commonmark-preview.editor.codeSpan.background`），不符合 VS Code 对颜色 id "仅允许字母、数字和点，且不能以点开头" 的校验规则；已统一改为 `markdown.commonmark.preview.editor.*`，并同步更新代码中的 `ThemeColor` 引用。

## [0.2.5] - 2026-10-15

### Added

- CommonMark 风格的 Markdown 预览（独立 Webview），主题跟随 VS Code 深色 / 浅色自动切换，无闪烁。
- 编辑与预览双向滚动联动，与 VS Code 内置预览完全一致（行级插值定位、代码块内逐行映射、50ms 节流连续跟动、防循环抑制）。
- 打开预览自动定位到编辑器当前行；图片加载完成后再定位，避免漂移。
- 支持扩展名：`.md` `.markdown` `.mdx` `.mdown` `.mkd` `.rmd` `.qmd` `.txt`。
- 常用编辑命令：加粗、斜体、删除线、行内代码、代码块、数学公式、列表、任务列表、目录生成 / 更新、表格格式化、导出 HTML。
- 渲染能力：KaTeX 数学公式、mermaid 图表、highlight.js 代码高亮、任务列表。

### Fixed

- 修复预览中图片无法渲染的问题：相对路径图片（如 `![](https://github.com/Liu-Project/markdown-commonmark-preview/raw/HEAD/img.png)`、`media/screenshots/light.png` 及原始 HTML `<img>`）现在会转换为 webview 可加载的绝对 URI，并与内置 Markdown 预览行为一致；`localResourceRoots` 同时覆盖扩展 media、文档所在目录与工作区根目录。
