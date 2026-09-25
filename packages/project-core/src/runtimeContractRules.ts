import path from "node:path";
import type ts from "typescript";
import type { ProjectDiagnostic } from "./types.js";

/** 规则语义版本独立于框架发布号。 / Rule semantics version is independent of the framework version. */
export const RUNTIME_CONTRACT_RULESET_VERSION = 1;

export interface RuntimeContractOptions {
  /** 必须使用创建 Program 的 TS 实例，避免跨版本 SyntaxKind。 / Use the API that created this Program. */
  readonly typescript: typeof ts;
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly sourceFiles?: readonly ts.SourceFile[];
}

type Compatibility = "yes" | "no" | "unknown";
const HOOKS = new Set(["Awake", "OnDestroy", "Deserialize", "CaptureTransfer", "RestoreTransfer"]);
const OWNERS = new Set(["Component", "Entity", "OwnedEntity", "Actor"]);
const FACTORIES = new Set(["NewOnceTimer", "NewRepeatedTimer"]);
const FACTORY_OWNERS = new Set(["Component", "OwnedEntity", "Actor", "Unit"]);

/** 在调用者的 Program 上检查当前 Core 契约，不创建第二个类型世界。 / Check this host's contracts in the caller's Program. */
export function runtimeContractDiagnostics(program: ts.Program, options: RuntimeContractOptions): ProjectDiagnostic[] {
  const api = options.typescript;
  const checker = program.getTypeChecker();
  const diagnostics: ProjectDiagnostic[] = [];
  const coreRoot = path.resolve(options.coreRoot);
  const contracts = new Map<ts.Type, ReadonlySet<string>>();
  const cancellationType = findCoreType("TimerCancelledContext");

  for (const source of options.sourceFiles ?? program.getSourceFiles()) {
    if (source.isDeclarationFile || isCore(source)) continue;
    visit(source);
  }
  return diagnostics.sort((a, b) => a.location.relativePath.localeCompare(b.location.relativePath, "en")
    || a.location.line - b.location.line || a.location.character - b.location.character || a.code.localeCompare(b.code, "en"));

  /** Core 身份由明确的宿主目录与声明确定。 / Identify Core by the declared host directory and source declaration. */
  function isCore(node: ts.Node): boolean {
    const relative = path.relative(coreRoot, node.getSourceFile().fileName);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  /** 遍历业务实现，声明文件只提供类型。 / Visit implementations; declaration files supply types only. */
  function visit(node: ts.Node): void {
    if (api.isClassDeclaration(node) || api.isClassExpression(node)) checkLifecycle(node);
    if (api.isCallExpression(node)) checkTimer(node);
    api.forEachChild(node, visit);
  }

  /** 继承、接口和导入别名最终必须落到当前 Core 声明。 / Resolve inheritance and interfaces to current Core declarations. */
  function coreContracts(type: ts.Type, visited = new Set<ts.Type>()): ReadonlySet<string> {
    const cached = contracts.get(type);
    if (cached) return cached;
    if (visited.has(type)) return new Set();
    visited.add(type);
    const result = new Set<string>();
    for (const declaration of type.getSymbol()?.declarations ?? []) {
      if (!api.isClassDeclaration(declaration) && !api.isClassExpression(declaration) && !api.isInterfaceDeclaration(declaration)) continue;
      if (declaration.name && isCore(declaration)) result.add(declaration.name.text);
      for (const heritage of declaration.heritageClauses ?? []) {
        for (const base of heritage.types) {
          for (const name of coreContracts(checker.getTypeAtLocation(base), visited)) result.add(name);
        }
      }
    }
    for (const base of type.getBaseTypes?.() ?? []) {
      for (const name of coreContracts(base, visited)) result.add(name);
    }
    contracts.set(type, result);
    return result;
  }

  /** 只检查框架拥有的实例钩子，同名工具类与静态方法不受影响。 / Check runtime-owned instance hooks, not homonyms. */
  function checkLifecycle(owner: ts.ClassLikeDeclaration): void {
    const identities = coreContracts(checker.getTypeAtLocation(owner));
    const owned = [...identities].some(name => OWNERS.has(name));
    for (const member of owner.members) {
      if (!api.isMethodDeclaration(member) && !api.isPropertyDeclaration(member)) continue;
      const name = propertyName(member.name);
      if (!name || !HOOKS.has(name) || member.modifiers?.some(item => item.kind === api.SyntaxKind.StaticKeyword)) continue;
      if (!owned && !(name === "OnDestroy" && identities.has("Singleton")) && !(name === "Deserialize" && identities.has("IDeserialize"))
        && !((name === "CaptureTransfer" || name === "RestoreTransfer") && identities.has("ITransfer"))) continue;
      if (api.isMethodDeclaration(member) && !member.body) continue;
      const implementation = api.isPropertyDeclaration(member) ? member.initializer : member;
      if (!implementation) continue;
      if (api.canHaveModifiers(implementation) && api.getModifiers(implementation)?.some(item => item.kind === api.SyntaxKind.AsyncKeyword)) {
        report(member.name, "tiangz.lifecycle.async-method", `${name} must be synchronous; remove the async modifier`);
        continue;
      }
      // 重载公开签名可能写 void，必须检查有执行体的实现签名。
      // Public overloads may say void; inspect the actual implementation signature.
      const bodySignature = api.isMethodDeclaration(implementation) || api.isArrowFunction(implementation) || api.isFunctionExpression(implementation)
        ? checker.getSignatureFromDeclaration(implementation) : undefined;
      const signatures = bodySignature ? [bodySignature] : checker.getSignaturesOfType(checker.getTypeAtLocation(implementation), api.SignatureKind.Call);
      const returns = signatures.map(signature => checker.getReturnTypeOfSignature(signature));
      if (returns.some(type => thenable(type, member))) {
        report(member.name, "tiangz.lifecycle.async-method", `${name} must be synchronous; its return type is ${returns.map(type => checker.typeToString(type)).join(" | ")}`);
      } else if (returns.some(type => unprovenType(type) || Boolean(type.flags & api.TypeFlags.Unknown))) {
        report(member.name, "tiangz.lifecycle.unverifiable", `${name} return type cannot be proven synchronous; use an explicit concrete return type`, "warning");
      }
    }
  }

  /** then 必须可调用；仅拥有数值 then 字段的 DTO 不是 Promise。 / A non-callable then field is not a thenable. */
  function thenable(type: ts.Type, location: ts.Node): boolean {
    if (type.isUnionOrIntersection()) return type.types.some(part => thenable(part, location));
    const then = checker.getPropertyOfType(type, "then");
    if (!then) return false;
    return checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(then, location)), api.SignatureKind.Call).length > 0;
  }

  /** 以已解析的 Core 工厂和实际 receiver 检查字符串派发。 / Validate the resolved Core factory and actual receiver. */
  function checkTimer(call: ts.CallExpression): void {
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.getDeclaration();
    if (!declaration || !api.isMethodDeclaration(declaration) || !isCore(declaration)) return;
    const name = propertyName(declaration.name);
    const factoryOwner = declaration.parent;
    if (!name || !FACTORIES.has(name) || !api.isClassDeclaration(factoryOwner) || !factoryOwner.name
      || !FACTORY_OWNERS.has(factoryOwner.name.text)) return;
    if (call.arguments.length < 2) return; // 参数数量由 TS 检查。 / TS checks factory arity.
    const expression = call.expression;
    if (!api.isPropertyAccessExpression(expression) && !api.isElementAccessExpression(expression)) {
      report(call, "tiangz.timer.unverifiable", `${name} receiver cannot be resolved; call the factory on its owner`, "warning");
      return;
    }
    let receiver = checker.getTypeAtLocation(expression.expression);
    if (expression.expression.kind === api.SyntaxKind.SuperKeyword) {
      let owner: ts.Node | undefined = call.parent;
      while (owner && !api.isClassDeclaration(owner) && !api.isClassExpression(owner)) owner = owner.parent;
      if (owner) receiver = checker.getTypeAtLocation(owner);
    }
    const methodNode = call.arguments[1]!;
    const supplied = call.arguments[2] ? checker.getTypeAtLocation(call.arguments[2]) : checker.getUndefinedType();
    checkNames(receiver, checker.getTypeAtLocation(methodNode), [supplied], methodNode, name);
    const optionsNode = call.arguments[3];
    if (!optionsNode) return;
    const optionsType = checker.getTypeAtLocation(optionsNode);
    if (unprovenType(optionsType)) {
      report(optionsNode, "tiangz.timer.unverifiable", `${name} cancellation options cannot be proven`, "warning");
      return;
    }
    for (const variant of optionsType.isUnion() ? optionsType.types : [optionsType]) checkCancellation(variant, optionsNode);

    /** 各 options 分支都可能发生取消，不漏掉无共同属性的联合。 / Check every options variant, including disjoint unions. */
    function checkCancellation(variant: ts.Type, optionsNode: ts.Expression): void {
      if (variant.flags & (api.TypeFlags.Undefined | api.TypeFlags.Null | api.TypeFlags.Never)) return;
      const cancellation = checker.getPropertyOfType(variant, "onCancelled");
      if (!cancellation) return;
      // 内联对象的属性会被上下文拓宽为 string；已知 initializer 仍保留字面量事实。
      // Contextual typing widens an inline property; its initializer still proves the literal value.
      const explicit = api.isObjectLiteralExpression(optionsNode) ? cancellationInitializer(optionsNode) : undefined;
      const valueType = explicit ? checker.getTypeAtLocation(explicit) : checker.getTypeOfSymbolAtLocation(cancellation, optionsNode);
      if (valueType.flags & api.TypeFlags.Undefined) return;
      const location = explicit ?? optionsNode;
      if (!cancellationType) {
        report(location, "tiangz.timer.unverifiable", `${name} current Core TimerCancelledContext is missing`, "warning");
        return;
      }
      checkNames(receiver, checker.getNonNullableType(valueType), [supplied, cancellationType], location, `${name} onCancelled`);
    }
  }

  /** 后写属性优先；后续 spread 可能覆盖时不沿用早先的字面量。 / A later spread can invalidate an earlier literal. */
  function cancellationInitializer(node: ts.ObjectLiteralExpression): ts.Expression | undefined {
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index]!;
      if (api.isSpreadAssignment(property)) return undefined;
      if (property.name && propertyName(property.name) === "onCancelled") {
        return api.isPropertyAssignment(property) ? property.initializer : api.isShorthandPropertyAssignment(property) ? property.name : undefined;
      }
    }
    return undefined;
  }

  /** 字面量联合逐一检查，动态字符串不猜测目标。 / Check every literal alternative; do not guess dynamic names. */
  function checkNames(receiver: ts.Type, names: ts.Type, args: readonly ts.Type[], node: ts.Node, label: string): void {
    const alternatives = names.isUnion() ? names.types : [names];
    if (!alternatives.length || alternatives.some(type => !type.isStringLiteral())) {
      report(node, "tiangz.timer.unverifiable", `${label} method name must have a string literal type to be checked`, "warning");
      return;
    }
    for (const type of alternatives) {
      if (!type.isStringLiteral()) continue;
      for (const owner of receiver.isUnion() ? receiver.types : [receiver]) checkTarget(owner, type.value, args, node, label);
    }
  }

  /** 允许忽略运行时附加参数，也允许未使用的可选参数。 / Callbacks may ignore supplied args and declare unused optional args. */
  function checkTarget(owner: ts.Type, name: string, args: readonly ts.Type[], node: ts.Node, label: string): void {
    const symbol = checker.getPropertyOfType(owner, name);
    if (!symbol) {
      const classThis = owner.getSymbol()?.declarations?.some(item => api.isClassDeclaration(item) || api.isClassExpression(item));
      const unknown = unprovenType(owner) && !classThis;
      report(node, unknown ? "tiangz.timer.unverifiable" : "tiangz.timer.target-missing",
        `${label} target does not exist on ${checker.typeToString(checker.getApparentType(owner))}: ${name}`, unknown ? "warning" : "error");
      return;
    }
    const type = checker.getTypeOfSymbolAtLocation(symbol, node);
    const signatures = checker.getSignaturesOfType(type, api.SignatureKind.Call);
    if (!signatures.length) {
      report(node, unprovenType(type) ? "tiangz.timer.unverifiable" : "tiangz.timer.not-callable",
        `${label} target is not callable: ${name}`, unprovenType(type) ? "warning" : "error");
      return;
    }
    const results = signatures.map(signature => compatible(signature, args, owner, node));
    if (results.includes("yes")) return;
    if (results.includes("unknown")) {
      report(node, "tiangz.timer.unverifiable", `${label} arguments cannot be proven compatible with ${name}; avoid any or unresolved generic callback types`, "warning");
    } else {
      report(node, "tiangz.timer.argument-mismatch", `${label} arguments (${checker.typeToString(args[0]!)}) do not match ${name}`);
    }
  }

  /** 检查实际的一或两个实参，重载任一匹配即可。 / Match the actual one or two arguments against each overload. */
  function compatible(signature: ts.Signature, args: readonly ts.Type[], owner: ts.Type, node: ts.Node): Compatibility {
    if (signature.typeParameters?.length) return "unknown";
    const results: Compatibility[] = [];
    if (signature.thisParameter) results.push(assignable(owner, checker.getTypeOfSymbolAtLocation(signature.thisParameter, node)));
    const parameters = signature.getParameters();
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      const declaration = parameter.valueDeclaration;
      const type = checker.getTypeOfSymbolAtLocation(parameter, node);
      if (declaration && api.isParameter(declaration) && declaration.dotDotDotToken) {
        results.push(restCompatible(type, args.slice(index)));
        break;
      }
      const argument = args[index];
      const optional = !!(parameter.flags & api.SymbolFlags.Optional)
        || !!(declaration && api.isParameter(declaration) && (declaration.questionToken || declaration.initializer));
      if (argument) {
        // 默认参数的声明类型不包含 undefined，但传入它会触发默认值。 / Undefined activates a default even when absent from the declared type.
        const alternatives = argument.isUnion() ? argument.types : [argument];
        results.push(combine(alternatives.map(value => optional && (value.flags & api.TypeFlags.Undefined) ? "yes" : assignable(value, type))));
      } else if (!optional) results.push("no");
    }
    return combine(results);
  }

  /** rest 按元素与元组必填位检查，不把数组类型当单个参数。 / Check rest element types and required tuple positions. */
  function restCompatible(type: ts.Type, args: readonly ts.Type[]): Compatibility {
    if (unprovenType(type)) return "unknown";
    if (checker.isTupleType(type)) {
      const elements = checker.getTypeArguments(type as ts.TypeReference);
      const flags = ((type as ts.TypeReference).target as ts.TupleType).elementFlags;
      const results: Compatibility[] = [];
      for (let index = 0; index < elements.length; index += 1) {
        const flag = flags[index]!;
        if (flag & api.ElementFlags.Variadic) return "unknown";
        if (flag & api.ElementFlags.Rest) {
          // 中间 rest 的后缀匹配暂不猜测。 / A rest followed by tuple elements requires a more complex match.
          if (index !== elements.length - 1) return "unknown";
          results.push(...args.slice(index).map(arg => assignable(arg, elements[index]!)));
          break;
        }
        const argument = args[index];
        if (argument) results.push(assignable(argument, elements[index]!));
        else if (flag & api.ElementFlags.Required) results.push("no");
      }
      return combine(results);
    }
    const element = checker.getIndexTypeOfType(type, api.IndexKind.Number);
    return element ? combine(args.map(arg => assignable(arg, element))) : "unknown";
  }

  /** any 与未实例化泛型不作为证明；unknown 仍参与正常可赋值检查。 / Any and unresolved generics are not proof. */
  function assignable(source: ts.Type, target: ts.Type): Compatibility {
    if (unprovenType(source) || unprovenType(target)) return "unknown";
    return checker.isTypeAssignableTo(source, target) ? "yes" : "no";
  }

  /** 汇总单个签名，确定的不匹配优先于未证明项。 / Definite mismatches take precedence within a signature. */
  function combine(results: readonly Compatibility[]): Compatibility {
    return results.includes("no") ? "no" : results.includes("unknown") ? "unknown" : "yes";
  }

  /** 识别类型擦除或尚未约束的结果。 / Recognize erased or unresolved types. */
  function unprovenType(type: ts.Type): boolean {
    return Boolean(type.flags & (api.TypeFlags.Any | api.TypeFlags.TypeParameter))
      || (type.isUnionOrIntersection() && type.types.some(unprovenType));
  }

  /** 仅从当前 Core 的顶层类型声明读取取消上下文。 / Read cancellation context only from current Core declarations. */
  function findCoreType(name: string): ts.Type | undefined {
    const source = program.getSourceFile(path.join(coreRoot, "public.ts"));
    const module = source && checker.getSymbolAtLocation(source);
    let symbol = module && checker.getExportsOfModule(module).find(item => item.name === name);
    if (symbol && symbol.flags & api.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.some(isCore) ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  }

  /** 只提取静态属性名。 / Extract statically named members. */
  function propertyName(name: ts.PropertyName): string | undefined {
    if (api.isComputedPropertyName(name) && (api.isStringLiteral(name.expression) || api.isNoSubstitutionTemplateLiteral(name.expression))) return name.expression.text;
    return api.isIdentifier(name) || api.isStringLiteral(name) || api.isNumericLiteral(name) ? name.text : undefined;
  }

  /** 返回零基位置供 CLI、LSP 使用同一结果。 / Return zero-based locations shared by CLI and LSP. */
  function report(node: ts.Node, code: string, message: string, severity: "error" | "warning" = "error"): void {
    const source = node.getSourceFile();
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push({ code, severity, message, location: {
      relativePath: path.relative(options.projectRoot, source.fileName).replaceAll("\\", "/"),
      line: position.line, character: position.character,
    } });
  }
}
