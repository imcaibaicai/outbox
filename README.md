# outbox

> 把本地目录可靠地送上 GitHub。一句话，不翻车。

[English abstract](#english-abstract) · MIT

`outbox` 把「推送」从一个每次都要现场拼命令的临时动作，变成一条**确定性的流水线**：

```
代理自动探测 → gh 登录态自愈 → 推送前安全闸门 → 建仓 / 提交 / 推送 → 远端 SHA 回读校验
```

**一份内核，三种用法**：命令行、任何 Agent（读 `SKILL.md`）、DeepSeek Harness 插件（`dsh-github-push`）。
三种外壳共用同一份代码，不存在「插件和 CLI 行为不一致」的问题。

---

## 它到底解决了什么

推送失败几乎从来不是因为 `git push` 写错了，而是因为**周围那些没人管的事**。下面是真实踩过的坑，以及 outbox 的处理方式：

| 真实故障 | 为什么会发生 | outbox 怎么处理 |
|---|---|---|
| `gh` 突然报「未登录」，可 `git push` 明明好好的 | gh 把登录态存在自己的 `hosts.yml` 里，该文件会因版本升级/配置迁移被清空；但 token 一直躺在系统凭据管理器里 | 检测到未登录时，从凭据管理器取出 token 自动灌回 gh，并**重新校验** |
| 网络时通时不通、推送卡死 | 环境变量里的代理并不是每条调用链都带着；代理关掉后变量还指着死端口 | 每次先探测端口，通则**按次注入**代理、不通则只清掉指向该端口的陈旧变量后直连 |
| 推着推着要输密码，挂在半路 | git 交互式询问 | 子进程一律置 `GIT_TERMINAL_PROMPT=0`，宁可清清楚楚失败，也不静默挂起 |
| 密钥被推上公开仓库 | 没人会在推送前逐行看 diff | 推送前扫描**即将提交的索引**，命中高危内容直接阻断 |
| 命令返回 0，但推的是旧东西 | 退出码不等于结果 | 推送后回读远端分支，**要求远端 SHA 严格等于本地 HEAD** 才算成功 |
| 仓库里写死了本机用户目录的绝对路径 | 无意识泄露身份 | 扫描绝对路径中的用户名、身份证号、手机号等，命中后**禁止自动公开** |

---

## 安装

零依赖，只要 Node ≥ 18。

```bash
git clone https://github.com/<your-account>/outbox.git
cd outbox
node src/cli.mjs --help
```

## 用法

```bash
# 先看一眼会发生什么（只做预检，不提交不推送）
node src/cli.mjs --dir ./my-project --visibility private --dry-run

# 发布到私有仓库（仓库不存在会自动创建）
node src/cli.mjs --dir ./my-project --visibility private --description "我的项目"

# 明确要开源时才用 public
node src/cli.mjs --dir ./my-project --visibility public
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--dir <路径>` | 要发布的目录（默认当前目录） |
| `--name <仓库名>` | 远端仓库名（默认由目录名规整而来） |
| `--visibility <值>` | `public` / `private` / `ask`（默认 `ask`） |
| `--proxy <值>` | `auto` / `off` / `http://host:port`（默认 `auto`，探测 7890） |
| `--proxy-port <端口>` | 代理探测端口，默认 `7890` |
| `--dry-run` | 只做预检 |
| `--json` | 结构化输出，便于脚本与 Agent 消费 |

退出码：`0` 成功 · `1` 出错 · `2` 预检阻断 · `3` 需要你先做决定

## 安全闸门

扫描的对象是**索引**（`git ls-files --cached`），也就是真正会被推上去的东西——因此 `.gitignore` 覆盖的文件天然不会被误报。

命中结果分三级：

| 级别 | 含义 | 行为 |
|---|---|---|
| `block` | 高置信度凭据：GitHub/OpenAI/AWS 令牌、私钥文件内容、`.env`/`*.pem`/`id_rsa` 等文件名、超过 95 MiB 的文件 | **硬阻断**，远端不会被创建 |
| `confirm` | 疑似个人敏感信息：身份证号、手机号、学号字段、暴露本机用户名的绝对路径，以及你自己的自定义模式 | **禁止自动公开**，必须逐条确认 |
| `warn` | 疑似明文口令/密钥赋值、超过 10 MiB 的大文件、**已被 gitignore 覆盖却仍在版本控制中的残留** | 只提示，不阻断 |

补充自定义模式：在 `~/.outbox/patterns.json` 写

```json
{ "confirm": [{ "id": "my-secret", "label": "我自己的敏感词", "pattern": "公司内部代号" }] }
```

### 放行清单

任何**带测试夹具的仓库**都会天然含有假密钥——测试扫描器就得放几个假 token 进去。没有出口的话，这种仓库会被自己的闸门拦住（outbox 第一次推送时，确实拦住了它自己）。

两种放行方式：

**仓库级**：在仓库根目录写 `.outboxallow`，每行一条：

```
# <路径 glob> [规则 id]
tests/selftest.mjs    github-token
tests/**/*.fixture.js
```

省略规则 id 表示放行该路径下的全部规则，但**建议永远写明确则 id**——放行范围越小越容易审计。这个文件本身会随仓库一起提交，所以「谁放行了什么」永远可查。

**行内**：在同一行写上 `outbox:allow`，该行的内容规则全部跳过。

被放行的命中不会凭空消失，而是记入结果的 `allowlisted` 字段，依旧可见。

## 设计取舍

**为什么代理不写进 git 全局配置？**
写全局最省事，但一旦代理软件关掉，本机**所有** git 操作（包括别的仓库）都会连不上。outbox 只在本次命令上用 `-c http.proxy=...` 注入，不留后遗症。

**为什么不用 `where.exe` 定位 git/gh？**
Windows 控制台工具按 OEM 代码页输出，而 Node 按 UTF-8 解码。只要可执行文件路径含中文（例如用户名是中文），解析结果就会变成一串替换字符，随后 `spawn` 报 `ENOENT`。更阴险的是 Git 常装在纯 ASCII 路径下所以一切正常——这个 bug 只在中文用户名的机器上爆发。正确做法是**把裸名字交给 Windows 自己按 PATH 解析**。

**为什么推送成功的判据是 SHA 而不是退出码？**
`git push` 返回 0 只代表命令没报错，不代表远端真的有你要的那个提交。回读 `git ls-remote` 拿到远端分支 SHA、与本地 `HEAD` 严格比对，才是可信证据。

**为什么安全闸门扫描索引而不是目录？**
索引就是「将要被推送的内容」，天然排除了忽略项，不会对 `.gitignore` 里的东西误报。

## 作为 Agent Skill 使用

`SKILL.md` 是给任意 Agent（Claude Code / Codex / DSH / 其它）读的说明书。把它放进你的技能目录，或直接贴进系统提示，Agent 就知道什么时候该调 `outbox`、什么时候必须先问用户。

## 相关项目

- [`dsh-plugin-publish`](https://github.com/suyukun/dsh-plugin-publish) —— 面向 Agent 技能的**发布流程协议**（preflight → 建仓 → awesome 列表 PR → 市场提交）。它是「说明书」，outbox 是「代码内核」，两者互补。

## English abstract

`outbox` reliably pushes a local folder to GitHub in a single command. It wraps the parts that actually break: auto-detecting a local proxy (default port 7890) and injecting it **per command** instead of globally, self-healing a `gh` login by recovering the token from the OS credential store, gating the push behind a secret/PII scan of the staged index, and verifying success by reading back the remote branch SHA instead of trusting an exit code. Zero dependencies, Node ≥ 18. One core, three shells: CLI, agent skill, and a DeepSeek Harness plugin.

## License

MIT
