# LightServer

轻量级服务部署工具，基于 [Bun](https://bun.sh)，提供类似 PHP 的部署体验：通过文件系统结构组织后端服务，使用注释标记区分入口与模块，无需复杂构建即可运行 TypeScript/JavaScript 服务，并与静态资源无缝共存。

## 特性

- **文件即路由**：请求路径直接映射到项目中的文件或目录。
- **注释标记识别**：入口文件用 `// @lightserver:main` 标记，模块文件用 `// @lightserver` 标记。
- **按需启动**：后端服务进程仅在首次被请求时启动，空闲自动回收，崩溃互不影响。
- **文件变更自动替换**：入口文件修改后，新请求自动触发进程替换，旧进程后台排水终止。
- **静态资源服务**：常见静态类型开箱即用，源码与模块文件默认不可访问。
- **多站点**：按 `Host` 头匹配 `hosts` 域名数组，或按站点独立端口分流；对不上的 Host 一律 421，无兜底。
- **路径路由**：同一站点内不同路径前缀可映射到不同目录（纯前缀 / glob / 正则）。
- **零配置启动**：无配置文件也能启动——首次运行自动生成全局配置模板（含 `/srv/websites/example.com` 示例站点）；站点根目录必须显式配置，无隐式默认值。
- **优雅关闭**：收到信号后通知子进程执行清理逻辑，排空后退出。

## 安装

要求 [Bun](https://bun.sh) >= 1.0（运行时与安装都需要 Bun）。

```bash
bun install -g @iyexin/lightserver
```

## 快速开始

### 1. 项目结构

```
my-app/
├── public/               # 静态资源根目录
│   ├── index.html
│   └── style.css
├── api/
│   ├── hello.ts          # 入口文件（含 @lightserver:main）
│   ├── helper.ts         # 模块文件（含 @lightserver）
│   └── (user).ts         # 固定前缀路由入口
└── lightserver.config.ts # 可选，项目本地配置
```

### 2. 编写服务

**入口文件**（`// @lightserver:main`）：

```typescript
// api/hello.ts
// @lightserver:main
import { helper } from './helper';

export default async function init(ctx: ServiceContext) {
  ctx.onRequest(async (req: Request) => {
    const url = new URL(req.url);
    const name = url.searchParams.get('name') || helper();
    return new Response(`Hello, ${name}!`);
  });
}
```

**模块文件**（`// @lightserver`）：

```typescript
// api/helper.ts
// @lightserver
export function helper() {
  return 'World';
}
```

**固定前缀路由入口**（带内部路由器）：

```typescript
// api/(user).ts
// @lightserver:main
export default async function init(ctx: ServiceContext) {
  const router = ctx.util.createRouter();

  router.get('/', async () => new Response('User root'));
  router.get('/:id', async (req, params) => new Response(`User ${params.id}`));

  ctx.onRequest(async (req: Request) => router.handle(req));
}
```

括号名是**字面量路径段**（区别于 Next.js 的 `[id]` 动态路由）：
`api/(user).ts` 处理 `/api/user` 与 `/api/user/*`，剩余部分以 `ctx.subPath` 传入。

### 3. 启动

```bash
lightserver start            # 后台常驻（终端可退出），用 stop/restart 管理
lightserver status           # 查看是否在运行
lightserver stop             # 优雅停止
lightserver restart          # 重启（可带新参数替换上次的）
lightserver dev              # 开发模式：前台运行、配置热重载、不缓存路由
lightserver start -f         # 前台运行（容器、systemd、调试用）
```

默认监听 `127.0.0.1:5600`。无 `-c` 且全局数据目录尚无配置文件时，
会在全局数据目录生成一份可直接运行的 `lightserver.config.ts` 起始模板。配置合并顺序（后者覆盖前者）：
内置默认值 < 全局配置 < `./lightserver.config.ts`（项目本地）
< `-c/--config` 指定文件 < CLI 参数。

## 工作原理

### 路由解析

1. 确定站点：走站点独立端口进来的请求直接归属该站点（免 Host 检查）；走主端口的按 `Host` 头在各站点的 `hosts` 里匹配（端口号忽略；精确 > 通配 `*.example.com` > 正则 `~`）；都不命中返回 421，不设兜底。
2. 在站点内按最长匹配选一条 `routes` 规则，得到文件系统根目录与查找路径；无规则则用站点根目录。
3. **精确匹配优先**：目录先找 `index.html`，再找带 `:main` 标记的 `index.ts`；文件检查标记与扩展名；无扩展名路径依次试 `<path>.ts`（入口服务）、`<path>.html`。
4. **动态前缀回退**：精确未命中时，向上逐级查找带 `:main` 标记的 `(name).ts`
  （`maxDepth` 层以内）；括号名须与对应路径段字面量一致，最深匹配优先；
   剩余路径作 `ctx.subPath`（以 `/` 开头，裸前缀时为 `/`）传入。

`start` 模式缓存判路结果（LRU，默认 60 秒，见 `routeCacheTtl`）：新文件最多延迟一个 TTL 可见；
入口文件内容变更仍经 mtime 即时热替换。`dev` 模式不缓存。

### 后端服务进程管理

- 每个入口文件对应一个独立 Bun 子进程，只走本地环回与主进程通信
  （POSIX 用 Unix socket，Windows 用 TCP 环回；连接复用 keepalive）。
- 全局共享进程池（默认上限 10，可按站点设软上限），LRU 淘汰，空闲默认 300 秒回收。
- 并发冷启动去重：同一入口的同时请求只触发一次启动，其余等待。
- 请求与响应体流式透传，不进内存缓冲；`content-length` 声明超 50MB 直接 413。
- 服务处理超时（默认 30 秒）→ 504；子进程崩溃/启动失败 → 502。
- 入口文件 mtime 变化时，下个请求启动新进程接管，旧进程后台排水终止。

## 编写后端服务

### ServiceContext API

| 成员                 | 类型                                          | 说明                                                            |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `onRequest(handler)` | `(req, ctx) => Response \| Promise<Response>` | 注册处理函数（仅一个，后注册覆盖）；第二个参数是当次请求上下文  |
| `onUnload(callback)` | `() => void \| Promise<void>`                 | 注册清理回调，优雅关闭时依次执行                                |
| `config`             | `Record<string, any>`                         | 站点 `serviceOptions`，按请求刷新                               |
| `env`                | `Record<string, string>`                      | 进程启动时的环境变量快照                                        |
| `log`                | `{ info, warn, error, debug }`                | 结构化日志（走 stderr）                                         |
| `signal`             | `AbortSignal`                                 | 退出信号，关闭时 abort                                          |
| `subPath`            | `string`                                      | 动态匹配的剩余路径（`/` 开头；裸前缀为 `/`；非动态匹配为 `""`） |
| `params`             | `Record<string, string>`                      | 路由参数，动态匹配时至少含 `{ prefix }`                         |
| `pathname`           | `string`                                      | 原始请求路径                                                    |
| `site`               | `string`                                      | 命中的站点名                                                    |
| `routeFile`          | `string`                                      | 本次请求的入口文件绝对路径                                      |
| `util`               | `{ createRouter(): Router }`                  | 创建子路径路由器                                                |

处理函数使用 Web 标准 `Request`/`Response`。注意：同一进程服务多个请求，
`init` 闭包捕获的 `ctx` 会在每次请求前刷新，推荐直接使用处理函数的第二个参数。

类型导入（先 `bun add -d @iyexin/lightserver`）：

```typescript
import type { ServiceContext } from '@iyexin/lightserver';
```

### 子路径路由器

`ctx.util.createRouter()` 创建的路由器绑定创建时的 `ctx`：有 `subPath` 时按子路径匹配，
否则按请求完整路径匹配，因此普通入口也能用。

- 方法：`get`、`post`、`put`、`delete`、`patch`、`options`、`head`、`query`，以及匹配任意方法的 `all`。
- 模式：`:param` 匹配单段（如 `/:id/update`）；末尾 `*` 捕获剩余路径到 `params["*"]`。
- 处理函数：`(req: Request, params: Record<string, string>) => Response | Promise<Response>`。
- `router.handle(req)` 分发并返回响应，无匹配返回 404。

### 状态码

| 情况                              | 状态码 |
| --------------------------------- | ------ |
| 处理函数抛错 / 返回非 `Response`  | 500    |
| 未注册处理函数、路径无匹配         | 404    |
| Host 无匹配站点                    | 421    |
| `serviceOptions` 超约 8KB 上限    | 500    |
| 子进程启动失败 / 连接中断         | 502    |
| 服务处理超时                      | 504    |
| `content-length` 声明超 50MB      | 413    |
| 静态资源用了非 GET/HEAD 方法      | 405    |
| 命中 `deny` / 访问模块文件 / 越界 | 403    |
| WebSocket 升级                    | 501    |

## 静态文件服务

- 白名单扩展名：`.html, .htm, .css, .js, .mjs, .json, .png, .jpg, .jpeg, .gif, .svg, .ico, .webp, .woff, .woff2, .ttf, .eot, .mp4, .webm, .mp3, .txt, .xml, .pdf`
- `.ts`/`.mts`/`.cts`/`.tsx` 永不作为静态资源返回（入口走服务，模块 → 403，未标记 → 404）。
- `.js`/`.mjs` 无标记可直接返回；一旦带 `@lightserver` 标记则 → 403。
- 支持 `ETag`/`Last-Modified`（命中返回 304）与 `HEAD`；不提供目录列表。

## 配置参考

全局配置是 JSONC（带注释的 JSON），项目本地与 `-c` 指定文件是
TypeScript（`export default` 导出对象即可，同名 `.js`/`.mjs` 也可；`-c` 也接受
`.jsonc`/`.json`）。`preProcess` 中间件在独立的 ts/js 文件里，JSONC 中声明路径、
TS 中可内联函数也可声明路径。

项目本地配置为当前目录 `lightserver.config.ts`，另可用 `-c/--config` 指定显式文件。

全局配置与默认日志集中存放在平台数据目录，可用 `LIGHTSERVER_DATA_DIR` 环境变量覆盖：

| 平台    | 数据目录                      | 全局配置                                       | 默认日志                                        |
| ------- | ----------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Linux   | `/etc/lightserver/`           | `/etc/lightserver/lightserver.jsonc`           | `/var/log/lightserver/lightserver.log`          |
| macOS   | `~/.lightserver/`             | `~/.lightserver/lightserver.jsonc`             | `/var/log/lightserver/lightserver.log`          |
| Windows | `%USERPROFILE%\.lightserver\` | `%USERPROFILE%\.lightserver\lightserver.jsonc` | `%USERPROFILE%\.lightserver\lightserver.log`    |

旧版 `~/.lightserver.config.ts` 仍作为回退读取（平台路径优先）。
注意 Linux/macOS 的数据与日志目录通常需要 root 写入：建议以 root 运行，或预建目录并授权；
建目录失败时启动打 warn，日志回退到 stderr。

| 字段                 | 类型                                       | 默认值                           | 说明                             |
| -------------------- | ------------------------------------------ | -------------------------------- | -------------------------------- |
| `port`               | `number`                                   | `5600`                           | 监听端口                         |
| `host`               | `string`                                   | `'127.0.0.1'`                    | 监听地址                         |
| `maxProcesses`       | `number`                                   | `10`                             | 全局共享进程池硬上限             |
| `idleTimeout`        | `number`                                   | `300`                            | 空闲淘汰秒数                     |
| `drainTimeout`       | `number`                                   | `10`                             | 排水等待秒数                     |
| `requestTimeout`     | `number`                                   | `30`                             | 服务请求超时秒数（→ 504）        |
| `routeCacheTtl`      | `number`                                   | `60`                             | 路由缓存秒数（0 关闭）           |
| `routeCacheSize`     | `number`                                   | `2000`                           | 路由缓存条目上限                 |
| `logFile`            | `string`                                   | `<数据目录>/lightserver.log`     | 日志文件（相对路径按 cwd 解析）  |
| `logMaxBytes`        | `number`                                   | `10485760`                       | 单文件超此字节数轮转             |
| `logMaxFiles`        | `number`                                   | `5`                              | 保留 `logFile.1..N`（≤0 不轮转） |
| `logFlushIntervalMs` | `number`                                   | `1000`                           | 日志异步刷盘间隔毫秒             |
| `staticExtensions`   | `string[]`                                 | 见上                             | 静态扩展名白名单                 |
| `sites`              | `Record<string, SiteConfig>`               | 无                               | 多站点配置                       |
| `preProcess`         | 函数 \| 路径                               | 无                               | 全局预处理中间件，见下           |
| `dynamicRouting`     | `{ enabled?: boolean; maxDepth?: number }` | `{ enabled: true, maxDepth: 5 }` | 动态路由设置                     |
| `logLevel`           | `string`                                   | `info`（`dev` 下为 `debug`）     | `debug \| info \| warn \| error` |

**SiteConfig**：

| 字段             | 类型                  | 说明                                                                          |
| ---------------- | --------------------- | ----------------------------------------------------------------------------- |
| `hosts`          | `string[]`            | 显式域名：精确、通配 `*.example.com`（不含裸域）、正则（`~` 开头）；与 `port` 必有其一 |
| `port`           | `number`              | 站点独立监听端口，该端口流量免 Host 检查；与主端口、其他站点端口均不得冲突    |
| `root`           | `string`              | 站点根目录（**必填**；相对路径按启动 cwd 解析）                               |
| `routes`         | 数组                  | 路径路由规则（`RouteRule`），最长匹配优先                    |
| `maxProcesses`   | `number`              | 站点软上限（池内该站进程数 cap，全局上限仍是硬上限）         |
| `redirects`      | 数组                  | `{ from, to, status? }`，`from` 可为精确路径或 `/old/*` 前缀 |
| `deny`           | `string[]`            | 精确/子树、glob（如 `/private/**`）或正则，命中 → 403        |
| `serviceOptions` | `Record<string, any>` | 传给服务的配置（经环回 header 传递，约 8KB 上限）            |

**RouteRule**（`routes` 数组元素）：

| 字段          | 类型      | 说明                                                              |
| ------------- | --------- | ----------------------------------------------------------------- |
| `match`       | `string`  | 纯前缀（`/api`，按路径段边界）、glob（`/static/**`）、正则（`~`） |
| `root`        | `string`  | 该规则的目录（相对路径按启动 cwd 解析）                           |
| `stripPrefix` | `boolean` | 纯前缀匹配时剥离前缀再映射文件（默认 `true`；glob/正则下忽略）    |

```jsonc
// 全局配置示例（lightserver.jsonc）：不同路径段路由到不同目录，生产环境用绝对路径
{
  "sites": {
    "example": {
      "root": "/srv/my-app/public",
      "routes": [
        { "match": "/", "root": "/srv/my-app/public" },
        { "match": "/api", "root": "/srv/my-app/api" },
        { "match": "/dl/*.zip", "root": "/srv/my-app/downloads" },
        { "match": "~^/api/v\\d+/", "root": "/srv/my-app/api" }
      ]
    }
  }
}
```

**多域名示例**（项目本地 TS 配置）：

```typescript
export default {
  sites: {
    example: { hosts: ['example.com', 'www.example.com'], root: './public' },
    api: { hosts: ['api.example.com'], root: './api' },
    internal: { port: 8081, root: './internal' },
  },
};
```

**预处理中间件**：独立 ts/js 文件默认导出函数，JSONC 中声明路径（相对声明它的配置文件），
TS 配置中可内联函数也可声明路径；`dev` 模式连带监听中间件文件变更。路径解析失败或导出非函数时启动报错。

```jsonc
// lightserver.jsonc
{
  "preProcess": "./middleware.ts"
}
```

```typescript
// middleware.ts（与 lightserver.jsonc 同目录）
export default (req, { site, pathname }) => {
  if (pathname === '/blocked') return new Response('blocked', { status: 403 });
  // 返回 Request 则替换原请求继续处理；返回空则放行
};
```

## 命令行

`start`（含 `-f` 前台模式）与 `dev` 共享服务选项；`stop`/`status` 无选项，
`restart` 可带与 `start` 相同的选项以替换上次启动参数。

```
lightserver start [options]     # 后台常驻，终端可退出
lightserver stop                # 优雅停止后台进程
lightserver restart [options]   # 重启；带参数时替换上次的启动参数
lightserver status              # 查看后台进程是否在运行
lightserver dev [options]       # 前台开发模式
```

| 选项                    | 说明                                    |
| ----------------------- | --------------------------------------- |
| `-f, --foreground`      | 只用于 `start`：前台运行，不 daemon 化  |
| `-c, --config <path>`   | 显式配置文件（覆盖自动发现）            |
| `-p, --port <n>`        | 监听端口（默认 5600）                   |
| `-H, --host <addr>`     | 监听地址（默认 127.0.0.1）              |
| `--max-processes <n>`   | 全局进程池上限（默认 10）               |
| `--idle-timeout <s>`    | 空闲淘汰秒数（默认 300）                |
| `--drain-timeout <s>`   | 排水等待秒数（默认 10）                 |
| `--request-timeout <s>` | 服务请求超时秒数（默认 30）             |
| `--log-level <level>`   | debug \| info \| warn \| error          |
| `--log-file <path>`     | 日志文件（默认见上表 `logFile`）        |
| `-v, --verbose`         | 等价于 `--log-level debug`              |
| `-h, --help`            | 帮助                                    |
| `-V, --version`         | 版本                                    |

启停状态记在数据目录的 `lightserver.pid` 里；`stop` 先走令牌保护的本地关闭通道，
再按需升级到信号，`dev` 启动的前台进程不受 `stop`/`status` 管理。

## 开发模式

```bash
lightserver dev --port 5600
```

与 `start` 的区别：配置热重载（端口/地址变更仍需重启）、入口文件变更立即淘汰旧进程、
路由缓存 bypass、默认 `debug` 日志。生产环境请用 `start`。

## 后台运行

`lightserver start` 默认即后台常驻：前端只负责拉起后端进程并确认就绪，
终端退出不影响运行（POSIX 下子进程免疫 SIGHUP，stdio 均不占终端）。
日常启停直接用 CLI，被 `stop` 杀掉的进程会先走优雅排水：

```bash
lightserver start
lightserver status
lightserver restart --port 8080   # 带参数重启：用新参数替换上次的
lightserver stop
```

容器或 systemd 这类自己负责守护的场景，用前台模式：

```ini
# /etc/systemd/system/lightserver.service
[Unit]
Description=LightServer
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/my-app
ExecStart=/root/.bun/bin/lightserver start --foreground
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now lightserver
curl http://127.0.0.1:5600/
tail -f /var/log/lightserver/lightserver.log
```

## 日志

JSON 行追加到日志文件（默认平台数据目录下的 `lightserver.log`），经内存缓冲定时异步刷盘，
单文件超限自动轮转。正常退出会刷盘；崩溃最多丢失一个刷盘间隔的日志。
子进程的 `console.log` 归集到同一文件；`ctx.log` 与启动期诊断走 stderr。

## 反向代理（Nginx）

```nginx
upstream lightserver { server 127.0.0.1:5600; keepalive 32; }

server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://lightserver;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}
```

## 安全注意事项

- 只监听本地地址，对外一律经反向代理。
- 严格虚拟主机：`Host` 对不上任何站点时返回 421，绝不 fallback 到某个站点；
  公网入口不要配无条件兜底。
- 模块与未标记脚本不可直接访问；路径穿越与符号链接逃逸返回 403。
- 以最小权限用户运行，定期更新 Bun 和 LightServer。

## 限制

- 不支持 WebSocket 升级（返回 501）。、
- 监听端口/地址变更需重启（其余配置 `dev` 下可热重载）。

## 许可证

MIT
