# TiangZ Developer Tools

TiangZ 框架的工程模型、静态检查与 VS Code 开发工具。

这个插件不替代 TypeScript，也不负责 `.native` 语言支持。它关注 TiangZ 特有的 Process、Scene、Actor、Component、Handler 和启动配置之间的关系。

## v0.1.0 能力

- 扫描 `configs/<环境>/**/*.json`，建立 Environment、Machine、Process 和入口 Scene 模型。
- 使用 TypeScript Compiler API 识别 `@entryScene`、`@scene`、`@actor` 和 `@component`。
- 识别类 Handler 与 `@rpc`、`@handler` 方法 Handler。
- 在资源管理器中显示“TiangZ 工程”树，并可跳转到配置或声明。
- 检查配置引用的入口 Scene 和 StartMachine 引用的进程配置。
- 将工程问题同时显示在工程树与 VS Code Problems 面板。
- 文件修改后防抖刷新，也可以手动执行“TiangZ：刷新工程索引”。

## 本地开发

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/tiangz-developer-tools-0.1.0.vsix`。

## 配置

默认配置适用于 TiangZ 主仓库：

```json
{
  "tiangzDeveloperTools.configRoot": "configs",
  "tiangzDeveloperTools.sourceRoots": ["app"]
}
```

## 工程边界

`packages/project-core` 不依赖 VS Code，只接收相对路径和文件文本。扩展负责文件发现、TreeView、Problems 和编辑器跳转。

当前版本刻意不包含启动、Debug 和运行时 Inspector。这些能力将在静态工程模型稳定后逐步加入，避免插件一开始就同时承担索引器、进程管理器和调试器。

详细设计见 [架构设计](docs/architecture.md)，后续顺序见 [路线图](docs/roadmap.md)。
