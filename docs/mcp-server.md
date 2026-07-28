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
