# MCP 服务

`tiangz-design-mcp`把 TiangZ 的确定性领域规则以只读 MCP 工具提供给其他 AI。它不扫描工程、不修改文件、不启动服务器，也不调用外部模型。

## 构建

```powershell
npm install
npm run build:design-mcp
```

构建产物是 `dist/tiangz-design-mcp.cjs`。安装 npm 包后也可使用同名命令 `tiangz-design-mcp`。

## 配置示例

不同 MCP 宿主的配置文件位置不同，服务定义等价于：

```json
{
  "mcpServers": {
    "tiangz-design": {
      "command": "node",
      "args": ["E:/gitee/TiangZ/tools-projects/tiangz-developer-tools/dist/tiangz-design-mcp.cjs"]
    }
  }
}
```

路径必须替换为实际绝对路径。stdio 的标准输出属于 MCP 协议，诊断信息只能写入标准错误。

## 工具

- `list_design_rules`：列出稳定规则编号和说明。
- `infer_system_archetype`：从简短需求识别 Item、Buff、Quest、Achievement 或 Numeric。
- `recommend_system_design`：按系统类型或完整 `DesignRequest` 返回 Markdown 与结构化结论。

三个工具均为只读、无破坏性操作。MCP 调用者可以解释结果，但不应把建议当作已验证代码，也不能绕过 TiangZ 的目录边界、项目检查和测试。

## 0.7 候选的独立 MCP 制品

MCP 握手版本由构建时的根 package.json 注入，移动 cjs 后无需再找仓库清单。`dist/tiangz-design-mcp.build-info.json` 记录包版本、锁、bundle 与依赖许可证的 SHA256；`dist/tiangz-design-mcp.NOTICES.txt` 只列实际打包依赖。AI 分发需同时携带这两个文件及本仓库 LICENSE/NOTICE，不依赖全局 npm 安装。

验收先在 RC1 安装产物复现握手仍报 0.13.0（`dist/v0.7-mcp-version-red.log`），改为清单注入后 `npm run check` 通过：156 项中 153 通过、3 项需指定实际宿主的条件跳过、0 失败，证据 `dist/v0.7-rc2-check.log`。MCP 协议回归核对实际服务版本、全部工具的只读标记与 Quest 返回。原 RC1 tag 保留；新 Core 为 0.16.1-rc.2，VSIX 0.16.2，未推送或发布。

随后指定 TIANGZ_TEST_MODULE_HOST，三项条件检查全部通过（跨 TS5/TS6 依赖/Hotfix 与真实模块 Host CLI/LSP）；定向日志 `dist/v0.7-rc2-host-contract.log`。
