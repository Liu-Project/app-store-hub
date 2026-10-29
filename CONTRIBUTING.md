# 参与贡献

感谢你愿意为插件中心（appStoreHub）贡献代码！请阅读以下指南。

## 开发环境

- Node.js >= 18
- VS Code >= 1.77

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 启动扩展开发宿主（VS Code 内按 F5）
```

## 开发流程

1. Fork 本仓库并创建功能分支：`git checkout -b feat/your-feature`。
2. 本地开发：`npm run watch` 开启增量编译。
3. 编写 / 更新单元测试（`tests/unit/`）。
4. 提交前运行全部检查：
   ```bash
   npm run lint        # ESLint
   npm run check-format # Prettier
   npm test            # 单元测试
   npm run compile     # 类型检查 + 编译
   ```
5. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：
   - `feat: 新增功能`
   - `fix: 修复缺陷`
   - `docs: 文档变更`
   - `refactor: 重构`
   - `test: 测试`
   - `chore: 构建或辅助工具变更`
6. 推送分支并发起 Pull Request，描述变更内容与测试结果。

## 分支与版本

- 主分支：`main`（保持可发布状态）。
- 版本号遵循语义化版本（SemVer），由维护者在发布时统一提升。

## 打包与发布

发布由维护者执行，不面向普通用户。

```bash
# 打包 .vsix
npm run package

# 发布到 Open VSX（需先在 https://open-vsx.org 注册 namespace 并获取访问令牌）
npx ovsx publish -p <OPEN_VSX_TOKEN>

# 发布到 VS Code Marketplace 请参考官方文档
# https://code.visualstudio.com/api/working-with-extensions/publishing-extension
```
