# file-match-compare（文件匹配对比）

> 根据选中的文件，按用户配置的**正则匹配替换规则**在工作区搜索左右两个配对文件，以左右编辑窗口对比打开，并支持多结果箭头跳转与序号显示。内置 HLTC/HLTP 适航用例前缀推导，开箱即用。

![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.2.0-blue)
![VS Code](https://img.shields.io/badge/vscode-%5E1.75.0-blue)

- 资源管理器右键文件 → **匹配对比**，直接以选中文件为基准搜索配对文件，无需手动输入
- 左窗口搜索选中文件本身，右窗口搜索按第一条命中的正则规则替换后的配对文件
- 支持**文件名**（含后缀）与**工作区相对路径**两类匹配目标，均可使用 `^` 锚点
- 左右两侧独立翻页，导航面板显示完整路径（自动换行、不省略）
- 搜索结果缓存，重复打开秒开

---

## 功能特性

### 匹配对比

- 右键点击文件 → 菜单项 **匹配对比**，直接使用被点击文件的文件名/相对路径（无需再输入）。
- **左窗口**打开选中原目标，**右窗口**打开规则替换后的目标（真实编辑器标签页，非预览、可直接编辑）。
- 导航面板（状态栏右侧「匹配对比导航」按钮显示/隐藏）：左右各自独立的「上一个 / 下一个」与序号指示器，展示完整路径；翻页时自动关闭旧标签，有未保存修改的标签不关闭。

### 匹配规则（正则替换）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `match` | - | 正则表达式，命中则派生右窗口搜索目标 |
| `replace` | - | 替换字符串 |
| `type` | `filename` | `filename`=仅文件名（含后缀，支持 `^` 锚点）；`path`=相对工作区根路径（支持 `^` 锚点） |

安装后**默认配置**已生效（设置界面 `fileMatchCompare.searchRules` 可见）：内置 `HLTC`↔`HLTP` 文件名互换与 `cos/` ↔ `pos/` 路径互换：

```json
"fileMatchCompare.searchRules": [
  { "match": "^HLTC_", "replace": "HLTP_", "type": "filename" },
  { "match": "^HLTP_", "replace": "HLTC_", "type": "filename" },
  { "match": "^cos/", "replace": "pos/", "type": "path" },
  { "match": "^pos/", "replace": "cos/", "type": "path" }
]
```

示例：

| 规则 | 选中文件 | 搜索目标（左 → 右） |
|------|----------|---------------------|
| `{"match":"^HLTC_","replace":"HLTP_"}` | `HLTC_CT_HM_UPGRADE_0120.txt` | `HLTC_CT_HM_UPGRADE_0120.txt` → `HLTP_CT_HM_UPGRADE_0120.txt` |
| `{"match":"^cos/","replace":"pos/","type":"path"}` | `cos/kernel/src/task.c` | `cos/kernel/src/task.c` → `pos/kernel/src/task.c` |

按顺序取**第一条命中**的规则；全部未命中时左右都搜索原文件。置空数组 `[]` 则回退到内置 HLTC/HLTP/HLTCTP 前缀推导。

---

## 快速开始

### 安装

从 VSIX 安装（适用于内部分发）：

```
code --install-extension file-match-compare-0.2.0.vsix
```

或在扩展视图 → `...` → 从 VSIX 安装。

### 使用

1. 用 VSCode 打开包含目标文件的工作区。
2. 资源管理器点击任意文件 → 右键 → **匹配对比**。
3. 插件自动搜索并打开：左窗口 = 选中文件、右窗口 = 规则替换后的配对文件（可编辑）。
4. 点击状态栏右侧「匹配对比导航」按钮显示/隐藏导航面板，使用左右箭头切换更多匹配文件。
5. 命令面板 `Ctrl+Shift+P` → `匹配对比` 可手动输入文件名；`打开匹配规则设置` 直达配置。

---

## 开发与构建

```bash
npm install          # 安装依赖
npm run compile      # 编译 TypeScript 到 out/
npm run package      # 打包 VSIX 到 releases/
```

调试：用 VSCode 打开本目录，按 `F5` 启动“扩展开发宿主”窗口。

---

## 发布说明

最新版本变更详见 [CHANGELOG.md](https://github.com/Liu-Project/file-match-compare/blob/HEAD/CHANGELOG.md)。

- **0.2.0**：首个公开版本，提供正则规则匹配替换、左右对比打开、导航翻页与结果缓存。

---

## 许可证

本扩展基于 [MIT License](https://github.com/Liu-Project/file-match-compare/blob/HEAD/LICENSE) 开源发布。
