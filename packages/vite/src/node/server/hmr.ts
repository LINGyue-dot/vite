import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import colors from 'picocolors'
import type { Update } from 'types/hmrPayload'
import type { RollupError } from 'rollup'
import { CLIENT_DIR } from '../constants'
import { createDebugger, normalizePath, unique, wrapId } from '../utils'
import type { ViteDevServer } from '..'
import { isCSSRequest } from '../plugins/css'
import { getAffectedGlobModules } from '../plugins/importMetaGlob'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import type { ModuleNode } from './moduleGraph'

export const debugHmr = createDebugger('vite:hmr')

const whitespaceRE = /\s/

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: Server
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + '/') ? path.posix.relative(root, file) : file
}

/**
 * @source hmr 处理
 * 如下三种直接重启服务器：vite.config 文件变化、vite config 中的依赖（用户手动指明的）变化、环境变量变化
 * 全量更新：客户端本身不能更新。没有模块更新并且是 html 文件变化
 */
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer,
  configOnly: boolean,
): Promise<void> {
  const { ws, config, moduleGraph } = server
  const shortFile = getShortName(file, config.root) // 绝对路径 b -> src/App.vue
  const fileName = path.basename(file) // 文件名称 b -> App.vue

  const isConfig = file === config.configFile // vite.config.js
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  ) // vite config 中的依赖（用户手动指明的）
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.')) // 环境变量
  /**
   * 如下三种直接重启服务器
   * vite.config 文件
   * vite config 中的依赖（用户手动指明的）
   * 环境变量
   */
  if (isConfig || isConfigDependency || isEnv) {
    // !!! 如果这三者就直接重启/重新构建
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      await server.restart()
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  if (configOnly) {
    return
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  /**
   * 全量更新
   * 1. client 自身无法热更新
   * 2. html 文件变化
   */
  // (dev only) the client itself cannot be hot updated.
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: 'full-reload',
      path: '*',
    })
    return
  }

  const mods = moduleGraph.getModulesByFile(file)

  // check if any plugin wants to perform custom HMR handling
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file),
    server,
  }

  for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
    const filteredModules = await hook(hmrContext) // b -> vite:watch-package-data 检查是否为 package.json 。 vite:vue 中的 handleHotUpdate 会生成新 ModuleNode
    if (filteredModules) {
      hmrContext.modules = filteredModules
    }
  }

  if (!hmrContext.modules.length) {
    // html file cannot be hot updated
    if (file.endsWith('.html')) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true,
      })
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + normalizePath(path.relative(config.root, file)),
      })
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`)
    }
    return
  }
  // @source 寻找 hmr 边界
  updateModules(shortFile, hmrContext.modules, timestamp, server)
}

/**
 * @source 寻找 hmr 边界，将 file 对应的 ModuleNode 进行失活处理
 * 并将 updates 数组传递给客户端或是 full-reload 指令
 */
export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean,
): void {
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>()
  const traversedModules = new Set<ModuleNode>()
  let needFullReload = false

  for (const mod of modules) {
    // 边界数组，最后被 push 到 updates 中
    const boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[] = []
    // propagateUpdate 返回 true 说明无法找到热更新边界，需要全量更新。如果为 false 说明找到热更新边界并存放在 boundaries 中
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    // 过期掉原先的 module
    moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
      boundaries.map((b) => b.boundary),
    )

    if (needFullReload) {
      continue
    }

    if (hasDeadEnd) {
      needFullReload = true
      continue
    }

    updates.push(
      ...boundaries.map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const, // b ->  js-update
        timestamp,
        path: normalizeHmrUrl(boundary.url),
        explicitImportRequired:
          boundary.type === 'js'
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: normalizeHmrUrl(acceptedVia.url),
      })),
    )
  }

  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: !afterInvalidation,
      timestamp: true,
    })
    ws.send({
      type: 'full-reload',
    })
    return
  }

  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  config.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(', ')),
    { clear: !afterInvalidation, timestamp: true },
  )
  // 将 upodates 数组传递给客户端
  ws.send({
    type: 'update',
    updates,
  })
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer,
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])]

  modules.push(...getAffectedGlobModules(file, server))

  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules),
      Date.now(),
      server,
    )
  }
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

/**
 * @source 寻找更新边界，如果没有找到就返回 true 使其全量更新
 * 找到了就 return false 并将其存入到 boundaries 中
 * 整体逻辑分为三部分，下方注释中有
 * 1. node.isSelfAccept = false 即自己文件有 import.meta.accept(cb) cb 的话就只将该文件塞入 updates --> .vue jsx tsx 等框架支持的
 * 2. importer.acceptedHmrDeps.has(nodeA) 引入该 node 的节点有进行 import.meta.accept('nodeA',cb) cb 有自己的处理逻辑，也将 importer 加入到 updates 中即可
 * 3. node.acceptedHmrExports 有值的话（即有用使用 import.meta.hot.acceptExports('exportA')）
 *  * 如果 acceptedHmrExports 的值和 importer 的 import 值相同 ，则不递归向上寻找
 *  * 防止，需要向上递归查找
 */
function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[],
  currentChain: ModuleNode[] = [node],
): boolean /* hasDeadEnd */ {
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }
  // isSelfAccepting = true 代表他有 import.hot.accept 函数，例如 vue jsx tsx ，这时候只需要将 node 放到 boundaries 中
  // 注意：.ts .js 文件的 isSelfAccepting  = false 他并没有自己的 import.meta.accept 函数
  // 让他执行自己的 hmr 函数即可
  // 第一部分：
  if (node.isSelfAccepting) {
    boundaries.push({ boundary: node, acceptedVia: node })

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer),
        )
      }
    }
    // false 说明找到边界，不需要全量更新
    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  // 第二部分：
  // node.acceptedHmrExports 表明当前注入了 import.meta.hot.acceptExports(xxx) 代码 -> vite:import-analysis 插件
  if (node.acceptedHmrExports) {
    // 实验属性，得手动开启
    boundaries.push({ boundary: node, acceptedVia: node })
  } else {
    // 没有文件 import 该 node 直接全量更新
    if (!node.importers.size) {
      return true
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    // 当前node不是CSS类型，但是CSS文件import目前的node，那么直接全量更新
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true
    }
  }
  // 第三部分
  // node.imports 指的是，node 被哪些文件 import 了，例如修改 react-ts/src/temp/index.ts ，那么此时 node.imports 就是 src/App.tsx
  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    // acceptedHmrDeps 如 import.meta.hot.accept([module_a,module_b]) -> [module_a,module_b]
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.push({ boundary: importer, acceptedVia: node })
      continue
    }

    /**
     * // B.js
     * const test = "B.js3";
     * import.meta.hot.acceptExports("test", (mod)=>{
     *     console.error("B.js热更新触发");
     * })
     * const test1 = "B1.js";
     * export {test, test1}
     * // A.js
     * import {test} from "./B.js";
     * console.info("A.js", test);
     * 假如此时修改 B.js
     * 1. 修改了 test 变量，此时 node.acceptedHmrExports = ['test']  importedBindingsFromNode = ['test'] 所以他只会将 B.js 加入 updates 中，而不会继续递归寻找
     * 2. 修改 test1 变量，由于 node.acceptedHmrExports = ['test'] 所以 areAllImportsAccepted = false ，就会继续走到下面，递归寻找并添加到 updates
     */
    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (currentChain.includes(importer)) {
      // circular deps is considered dead end
      return true
    }
    // 继续递归向上寻找边界
    if (propagateUpdate(importer, traversedModules, boundaries, subChain)) {
      return true
    }
  }
  return false
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(url)
  }
  return url
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, 'utf-8')
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs
    await new Promise((r) => {
      let n = 0
      const poll = async () => {
        n++
        const newMtime = (await fsp.stat(file)).mtimeMs
        if (newMtime !== mtime || n > 10) {
          r(0)
        } else {
          setTimeout(poll, 10)
        }
      }
      setTimeout(poll, 10)
    })
    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}
