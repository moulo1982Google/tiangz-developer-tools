import path from "node:path";
import type ts from "typescript";
import type { ProjectDiagnostic } from "./types.js";

export interface HotfixStateOptions {
  /** 与 SourceFile/Checker 同一版本的 TS。 / The TS API that created the SourceFile and checker. */
  readonly typescript: typeof ts;
  readonly projectRoot: string;
  readonly coreRoot: string;
}

export type HotfixDecoratorKind = "System" | "Handler";
const systems = new Set(["hotfixFor", "systemFor"]);
const handlers = new Set([
  "messageHandler", "rpcHandler", "httpHandler", "sessionMessageHandler", "sessionRpcHandler",
  "unitMessageHandler", "unitRpcHandler", "syncEventHandler", "vetoEventHandler", "entityExtensionHandler",
]);

/** 只返回由当前 Core 声明确认的行为类，不把同名业务装饰器当作框架。 / Returns only behavior classes verified against the current Core declarations. */
export function restrictedHotfixDecoratorKind(
  node: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  options: HotfixStateOptions,
): HotfixDecoratorKind | undefined {
  const identity = behaviorIdentity(node, checker, options);
  return identity?.verified ? identity.kind : undefined;
}

/** 共享成员禁令；无类型环境只给出未证明 warning，不冒充编译错误。 / Shares member restrictions; missing type evidence produces an unverified warning, never a compiler error. */
export function hotfixClassDiagnostics(
  source: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  options: HotfixStateOptions,
): ProjectDiagnostic[] {
  const api = options.typescript;
  const diagnostics: ProjectDiagnostic[] = [];
  const relativePath = path.relative(options.projectRoot, source.fileName).replaceAll("\\", "/");
  visit(source);
  return diagnostics;

  function visit(node: ts.Node): void {
    if (api.isClassDeclaration(node)) {
      const identity = behaviorIdentity(node, checker, options);
      if (identity) for (const member of node.members) {
        if (!api.isConstructorDeclaration(member) && !api.isPropertyDeclaration(member)
          && !api.isClassStaticBlockDeclaration(member)
          && !(api.canHaveModifiers(member) && api.getModifiers(member)?.some(modifier => modifier.kind === api.SyntaxKind.StaticKeyword))) continue;
        const position = source.getLineAndCharacterOfPosition(member.getStart(source));
        diagnostics.push({
          code: identity.verified ? "tiangz.hotfix.instance-state" : "tiangz.hotfix.unverifiable",
          severity: identity.verified ? "error" : "warning",
          message: identity.verified
            ? `${identity.kind}类只能声明实例方法/accessor，不能声明字段、构造函数或static成员；状态应放回 Model Scene/Entity/Component。 / Behavior classes must keep state and construction in Model.`
            : "缺少当前宿主装饰器的类型证据；此成员形状用于 Hotfix 行为类时会被拒绝，请运行宿主类型检查。 / Decorator identity is unverified; run the selected host's type checks.",
          location: { relativePath, line: position.line, character: position.character },
        });
      }
    }
    api.forEachChild(node, visit);
  }
}

function behaviorIdentity(
  node: ts.ClassDeclaration,
  checker: ts.TypeChecker | undefined,
  options: HotfixStateOptions,
): { readonly kind: HotfixDecoratorKind; readonly verified: boolean } | undefined {
  const api = options.typescript;
  let unverified: HotfixDecoratorKind | undefined;
  for (const decorator of api.getDecorators(node) ?? []) {
    if (!api.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    if (checker) {
      let symbol = checker.getSymbolAtLocation(expression);
      const visited = new Set<ts.Symbol>();
      while (symbol && (symbol.flags & api.SymbolFlags.Alias) !== 0 && !visited.has(symbol)) {
        visited.add(symbol);
        symbol = checker.getAliasedSymbol(symbol);
      }
      if (symbol?.declarations?.length) {
        const currentCore = symbol.declarations.some(declaration => {
          const relative = path.relative(path.resolve(options.coreRoot), declaration.getSourceFile().fileName);
          return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        const kind = currentCore ? decoratorKind(symbol.getName()) : undefined;
        if (kind) return { kind, verified: true };
        continue;
      }
    }
    // 只有显式稳定入口导入能产生候选提示；本地同名函数不是证据。 / Only explicit stable imports qualify for an advisory; local names are not evidence.
    const source = node.getSourceFile();
    for (const statement of source.statements) {
      if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== "#tiangz/model") continue;
      const binding = statement.importClause?.namedBindings;
      if (binding && api.isNamedImports(binding) && api.isIdentifier(expression)) {
        const imported = binding.elements.find(item => item.name.text === expression.text);
        if (imported) unverified = decoratorKind(imported.propertyName?.text ?? imported.name.text) ?? unverified;
      } else if (binding && api.isNamespaceImport(binding) && api.isPropertyAccessExpression(expression)
        && api.isIdentifier(expression.expression) && expression.expression.text === binding.name.text) {
        unverified = decoratorKind(expression.name.text) ?? unverified;
      }
    }
  }
  return unverified ? { kind: unverified, verified: false } : undefined;
}

function decoratorKind(name: string): HotfixDecoratorKind | undefined {
  return systems.has(name) ? "System" : handlers.has(name) ? "Handler" : undefined;
}
