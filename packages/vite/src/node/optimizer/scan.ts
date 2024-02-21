import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type { BuildContext, Loader, OnLoadResult, Plugin } from 'esbuild'
import esbuild, { formatMessages, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>
  result: Promise<{
    deps: Record<string, string>
    missing: Record<string, string>
  }>
} {
  // Only used to scan non-ssr code
  // !!! 计时从这开始
  const start = performance.now()
  // key-value --> 包名称 - 绝对路径
  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  let entries: string[]

  const scanContext = { cancelled: false }
  // 计算项目入口文件
  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config,
  ).then((computedEntries) => {
    entries = computedEntries

    if (!entries.length) {
      if (!config.optimizeDeps.entries && !config.optimizeDeps.include) {
        config.logger.warn(
          colors.yellow(
            '(!) Could not auto-determine entry point from rollupOptions or html files ' +
              'and there are no explicit optimizeDeps.include patterns. ' +
              'Skipping dependency pre-bundling.',
          ),
        )
      }
      return
    }
    if (scanContext.cancelled) return

    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join('')}`,
    )
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext)
  })

  // esbuildContext 时候会加载
  const result = esbuildContext
    .then((context) => {
      function disposeContext() {
        // dispose 释放 context 上下文内存
        return context?.dispose().catch((e) => {
          config.logger.error('Failed to dispose esbuild context', { error: e })
        })
      }
      if (!context || scanContext?.cancelled) {
        disposeContext()
        return { deps: {}, missing: {} }
      }
      return (
        context
          // @source esbuild 构建
          .rebuild()
          .then(() => {
            // @time -->
            return {
              // Ensure a fixed order so hashes are stable and improve logs
              deps: orderedDependencies(deps),
              missing,
            }
          })
          .finally(() => {
            return disposeContext()
          })
      )
    })
    .catch(async (e) => {
      if (e.errors && e.message.includes('The build was canceled')) {
        // esbuild logs an error when cancelling, but this is expected so
        // return an empty result instead
        return { deps: {}, missing: {} }
      }

      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join('\n')}

  `)
      if (e.errors) {
        const msgs = await formatMessages(e.errors, {
          kind: 'error',
          color: true,
        })
        e.message = prependMessage + msgs.join('\n')
      } else {
        e.message = prependMessage + e.message
      }
      throw e
    })
    .finally(() => {
      if (debug) {
        const duration = (performance.now() - start).toFixed(2)
        const depsStr =
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join('') || colors.dim('no dependencies found')
        debug(`Scan completed in ${duration}ms: ${depsStr}`)
      }
    })

  return {
    cancel: async () => {
      scanContext.cancelled = true
      return esbuildContext.then((context) => context?.cancel())
    },
    result,
  }
}
/**
 * 获取入口：优先配置中传入的入口，没有的话就 await globEntries('**\/.html', config)
 */
async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = []
  // user config
  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    // 默认 index.html 作为入口
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) => isScannable(entry) && fs.existsSync(entry),
  )

  return entries
}
// 初始化 esbuild 插件，同时利用 esbuild.context 创建构建上下文
async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean },
): Promise<BuildContext | undefined> {
  // TODO!!! 这里为什么又生成个新的 container vite plugin container 初始化
  const container = await createPluginContainer(config)

  if (scanContext?.cancelled) return

  const plugin = esbuildScanPlugin(config, container, deps, missing, entries) // vite:scan 插件

  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}
  // !!! esbuild.context 不是打包，只是长时间运行的构建上下文
  // 会将数据存在 context 中，调用 context.rebuild() 会进行增量构建
  // 第二次打包在 packages/vite/src/node/optimizer/index.ts#787 其中会对 vue 等三方包进行打包并生成在 /node_modules/.vite/dep/vue.js
  // 其中就会执行 esbuildScanPlugin 中的 plugins
  return await esbuild.context({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join('\n'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  })
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies 排序下
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

/**
 * 构建 esbuild 插件，内部主要根据文件来进行添加 import 以及定位到绝对路径
 */
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  // key-value -> 包名称 - 绝对路径
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
): Plugin {
  const seen = new Map<string, string | undefined>()
  // 获取完整路径
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path),
  })

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents
    // transpile because `transformGlobImport` only expects js
    if (loader !== 'js') {
      // !! esbuild transform
      transpiledContents = (await transform(contents, { loader })).code
    } else {
      transpiledContents = contents
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve,
      config.isProduction,
    )

    return result?.s.toString() || transpiledContents
  }
  // @warning 注意这里 debug 一定要清空缓存
  return {
    name: 'vite:dep-scan',
    setup(build) {
      // 调用权在 esbuild
      // 所有 build 先经过 onResolve 返回真实路径再 onLoad
      // 如果 onLoad 没有返回值就会再放到下一个 onLoad
      const scripts: Record<string, OnLoadResult> = {}

      // external urls
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      // 解析 vue/html 文件
      // 1. html/vue 文件先经过这个处理，处理完成之后传递给 onLoad
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved,
          namespace: 'html',
        }
      })

      // extract scripts inside HTML-like files and treat it as a js module
      // 2. html、Vue 文件会提取出 script 标签 -> 内联标签与外部 script
      // 外部 script 会直接转为 import 语句引入外部 script
      // 内联 script 内容会作为虚拟模块引入
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          // path 是绝对路径
          let raw = await fsp.readFile(path, 'utf-8')
          // Avoid matching the content of the comment
          // 先将注释的内容清空
          // App.vue 同样被这样处理，raw 就是整个文件的字符串
          raw = raw.replace(commentRE, '<!---->')
          const isHtml = path.endsWith('.html')
          scriptRE.lastIndex = 0
          let js = ''
          let scriptId = 0
          let match: RegExpExecArray | null
          // 匹配是否是 script tag
          while ((match = scriptRE.exec(raw))) {
            const [, openTag, content] = match
            // 拿到 script tag 的 type
            const typeMatch = openTag.match(typeRE)
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip non type module script
            // !!! dev 下预构建会跳过所有非 module 的 script 标签
            if (isHtml && type !== 'module') {
              continue
            }
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            } else if (path.endsWith('.astro')) { // 单独服务 astro
              loader = 'ts'
            }
            const srcMatch = openTag.match(srcRE)
            // >>> 外部 script 标签，直接引入外部 script
            if (srcMatch) {
              // 拿到 src ，并将 src 的内容放到 content 中添加上 import src
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // >>> 内联 script 标签
              // 会将 script 标签内容弄成一个虚拟模块，并在原 vue/html 文件中直接 import 引入
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              // 再添加上 import './components/HelloWorld.ts''
              // 变成了 'import HelloWorld from './components/HelloWorld.ts' \n import './components/HelloWorld.ts' 防止被擦除
              const contents =
                content +
                (loader.startsWith('ts') ? extractImportPaths(content) : '')

              const key = `${path}?id=${scriptId++}`
              // 正则引入多个文件
              if (contents.includes('import.meta.glob')) {
                scripts[key] = {
                  loader: 'js', // since it is transpiled
                  contents: await doTransformGlobImport(contents, path, loader), // 转译成真实路径以及真实文件名称
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              } else {
                scripts[key] = {
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              }
              // 虚拟模块
              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key,
              )

              const contextMatch = openTag.match(contextRE) // 似乎是 .svelte 文件专属属性 context
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])

              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>

              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                // 将内联 script 转为虚拟模块，后在其中 import
                js += `export * from ${virtualModulePath}\n`
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          // 添加上 export default {}
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }
          // 入口文件index.html 引入的 main.ts loader 仍然是 js
          // 而 .vue 文件中 lang = ts 的 loader 就是 ts
          // 那么不添加 script lang = ts 且在 main.ts 中不添加 ts 类型可以吗？--> 应该是不行的
          return {
            loader: 'js',
            contents: js,
          }
        },
      )

      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/,
        },
        // 此时解析 import Vue from 'vue'
        // id = vue
        async ({ path: id, importer, pluginData }) => {
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          // resolve 绝对路径 xxx/main-process/node_modules/vue/dist/vue.runtime.esm-bundle.js
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            //
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                //
                depImports[id] = resolved
              }
              return externalUnlessEntry({ path: id })
            } else if (isScannable(resolved)) {
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace,
              }
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            missing[id] = normalizePath(importer)
          }
        },
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry)

      // json & wasm
      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry)

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`),
        },
        externalUnlessEntry,
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true,
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/,
        },
        // TODO 这里只是对 js 的分析，main.ts 是 ts 应该变现与这个不一致
        // id = /src/main.js
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          // resolved = xxx/main-process/src/main.js
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              // path = xxx/main-process/src/main.js
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        },
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = await fsp.readFile(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        if (contents.includes('import.meta.glob')) {
          return {
            loader: 'js', // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          }
        }

        return {
          loader,
          // contents 就是解析 main.js 的内容
          // `import { createApp } from "vue";
          // import App from "./App";
          // import { toString, toArray } from "lodash-es";
          // console.log(toString(123));
          // console.log(toArray([]));
          // createApp(App).mount("#app");`
          // !!! 这里面的 import 会再度触发 onResolve
          // !!! id 就是 from 中的内容
          contents,
        }
      })
    },
  }
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
