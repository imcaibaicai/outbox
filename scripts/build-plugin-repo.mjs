#!/usr/bin/env node
/**
 * 生成 dsh-github-push 插件仓库的工作树。
 *
 * 为什么要单独一个仓库：DSH 插件市场按 GitHub 的 `dsh-plugin` 话题抓取，
 * 插件得有自己的仓库才进得去。但**真相源仍然是 outbox 主仓库** ——
 * 本脚本先跑一遍同步（保证内核副本最新），再把插件包摊平到目标目录，
 * 并生成面向市场的 README。
 *
 * 用法：
 *   node scripts/build-plugin-repo.mjs --out <目标目录>
 */

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { run } from '../src/outbox.mjs';

const root = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--out') {
			opts.out = argv[i + 1];
			i += 1;
		}
	}
	return opts;
}

const { out } = parseArgs(process.argv.slice(2));
if (typeof out !== 'string' || out.trim().length === 0) {
	process.stderr.write('用法：node scripts/build-plugin-repo.mjs --out <目标目录>\n');
	process.exit(1);
}
const targetDir = path.resolve(out);

/* ---------- 1. 先保证内核副本是最新的（复用同步脚本，不重复实现） ---------- */
execFileSync(process.execPath, [path.join(root, 'scripts', 'sync-plugin.mjs')], { stdio: 'inherit' });

/* ---------- 2. 从 git 远端推导 owner（不把账号写死在源文件里） ---------- */
const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 30_000 });
const remoteUrl = remote.stdout.trim();
const owner = /github\.com[/:]([^/]+)\//.exec(remoteUrl)?.[1] ?? null;
if (owner === null) {
	process.stderr.write(`无法从 origin 推导 owner（origin=${remoteUrl || '(空)'}）\n`);
	process.exit(1);
}

const pluginPkgPath = path.join(root, 'dsh-plugin', 'package.json');
const pluginPkg = JSON.parse(await fs.readFile(pluginPkgPath, 'utf8'));

/* ---------- 3. 摊平插件包到目标目录 ---------- */
await fs.mkdir(path.join(targetDir, 'lib'), { recursive: true });

await fs.copyFile(path.join(root, 'dsh-plugin', 'lib', 'index.js'), path.join(targetDir, 'lib', 'index.js'));
await fs.copyFile(path.join(root, 'dsh-plugin', 'lib', 'outbox.mjs'), path.join(targetDir, 'lib', 'outbox.mjs'));
await fs.copyFile(pluginPkgPath, path.join(targetDir, 'package.json'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(targetDir, 'LICENSE'));

await fs.writeFile(
	path.join(targetDir, '.gitignore'),
	['# 依赖与编辑器临时文件', 'node_modules/', '.DS_Store', 'Thumbs.db', '*.log', ''].join('\n'),
	'utf8',
);

/* ---------- 4. 放行清单 ----------
 * 内嵌内核里必然出现「口令字段名 + 等号」的字面量，会被那条宽泛的启发式规则
 * 命中。写进放行清单比关掉扫描诚实得多，也让「为什么放行」留在仓库里。
 */
await fs.writeFile(
	path.join(targetDir, '.outboxallow'),
	[
		'# 本仓库是 outbox 内核的发布产物，内嵌内核由 scripts/sync-plugin.mjs 生成。',
		'# 内核里解析凭据的代码必然出现「口令字段名 + 等号」字面量，会被宽泛规则命中。',
		'lib/outbox.mjs    password-assign',
		'',
	].join('\n'),
	'utf8',
);

/* ---------- 5. 面向插件市场的 README ---------- */
const repoUrl = `https://github.com/${owner}/${path.basename(targetDir)}`;
const coreUrl = `https://github.com/${owner}/outbox`;

const readme = `# dsh-github-push

> DeepSeek Harness 插件：**一句话把本地目录推送到 GitHub**。

注册一个模型工具 \`github_push\`。你对 Agent 说「把这个项目开源到 GitHub」，它就能走完全程：
探测代理 → 自愈 gh 登录态 → 扫描密钥与个人信息 → 建仓/提交/推送 → 回读远端 SHA 校验。

内核来自 [outbox](${coreUrl}) 项目，本仓库是它的**发布产物**（内嵌内核由
\`scripts/sync-plugin.mjs\` 自动同步，不是手写的第二实现）。

## 它替你挡掉了什么

| 常见故障 | 处理方式 |
|---|---|
| \`gh\` 突然报未登录，但 \`git push\` 明明正常 | 登录态文件会被清空，token 却还在系统凭据管理器里 —— 自动取回并重新校验 |
| 代理时通时不通，或关掉代理后命令卡死 | 先探测 \`127.0.0.1:7890\`：通则**按次注入**，不通则只清掉指向该端口的陈旧变量后直连 |
| 推到一半卡在输密码 | 子进程一律禁止交互询问，宁可明确失败也不静默挂起 |
| 密钥被推上公开仓库 | 推送前扫描**即将提交的索引**，命中高危内容直接阻断并列出文件与行号 |
| 命令返回 0，但推的其实是旧东西 | 回读远端分支，要求**远端 SHA 严格等于本地 HEAD** 才算成功 |
| 仓库里写死了本机用户目录路径 | 扫描绝对路径中的用户名、身份证号、手机号等，命中后**禁止自动公开** |

## 工具契约：\`github_push\`

| 参数 | 必填 | 说明 |
|---|---|---|
| \`dir\` | ✅ | 要发布的目录，**必须是绝对路径** |
| \`visibility\` | ✅ | \`public\` / \`private\` / \`ask\` |
| \`name\` | | 远端仓库名，默认由目录名规整而来 |
| \`description\` | | 仓库描述 |
| \`message\` | | 提交信息 |
| \`dryRun\` | | 只预检，不提交不推送 |

**可见性规则（刻意设计成不能由模型代劳）**：用户明确说公开/开源才传 \`public\`；
明确说私有才传 \`private\`；**其它情况一律 \`ask\`** —— 此时工具不会创建任何远端仓库，
只做预检并返回需要确认的问题，由 Agent 拿去问用户。

安全闸门命中个人信息时，即使请求了 \`public\` 也会停下来要求逐条确认。

## 安装

本插件是标准的 DSH host 插件（在 \`cordis.patch.yml\` 里插一行 loader 行）。
把包放进 profile 的 \`node_modules\`，然后加一行：

\`\`\`yaml
- insert:
    - id: github-push
      name: 'dsh-github-push'
\`\`\`

**host 插件在启动时装载，必须完全退出 DSH 再重启才生效。**

> 不想装插件也行：同一份内核还有命令行外壳与 Agent 通用 \`SKILL.md\`，见 [outbox](${coreUrl})。

## 相关项目

- [outbox](${coreUrl}) —— 内核本体，同时提供 CLI 与 Agent 通用 Skill
- [dsh-plugin-publish](https://github.com/suyukun/dsh-plugin-publish) —— 面向 Agent 技能的发布流程协议，与本插件互补

## License

MIT
`;

await fs.writeFile(path.join(targetDir, 'README.md'), readme, 'utf8');

process.stdout.write(`已生成插件仓库工作树：${targetDir}\n`);
process.stdout.write(`  owner   = ${owner}\n`);
process.stdout.write(`  package = ${pluginPkg.name}@${pluginPkg.version}\n`);
process.stdout.write(`  仓库地址 = ${repoUrl}\n`);
