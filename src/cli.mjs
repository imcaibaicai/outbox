#!/usr/bin/env node
/**
 * outbox 命令行外壳 —— 人类与任何 Agent 都能直接用。
 *
 * 这里**只做参数解析与结果渲染**，不含任何业务逻辑。
 * 所有硬逻辑都在 src/outbox.mjs 里，保证与 DSH 插件走的是同一份代码。
 *
 * 退出码（便于脚本与 Agent 判断）：
 *   0  成功且通过回读校验
 *   1  出错
 *   2  预检阻断（发现了高危内容）
 *   3  需要用户先做决定（可见性 / 敏感信息）
 */

import { publish, DEFAULTS } from './outbox.mjs';

function parseArgs(argv) {
	const opts = { flags: new Set() };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith('--')) {
			if (opts.dir === undefined) opts.dir = token;
			continue;
		}
		const key = token.slice(2);
		const needsValue = ['dir', 'name', 'visibility', 'description', 'message', 'branch', 'proxy', 'proxy-port', 'timeout'];
		if (!needsValue.includes(key)) {
			opts.flags.add(key);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`参数 --${key} 缺少取值`);
		opts[key] = value;
		i += 1;
	}
	return opts;
}

const USAGE = `outbox —— 把本地目录可靠地送上 GitHub

用法
  node src/cli.mjs [目录] [选项]

选项
  --dir <路径>            要发布的目录（默认当前目录）
  --name <仓库名>         远端仓库名（默认由目录名规整而来）
  --visibility <值>       public | private | ask   （默认 ask）
  --description <文本>    仓库描述
  --message <文本>        提交信息
  --branch <名字>         分支名（默认 ${DEFAULTS.branch}）
  --proxy <值>            auto | off | http://host:port   （默认 auto）
  --proxy-port <端口>     代理探测端口（默认 ${DEFAULTS.proxyPort}）
  --dry-run               只做预检，不提交不推送
  --json                  以 JSON 输出结果
  --help                  显示本帮助

退出码
  0 成功    1 出错    2 预检阻断    3 需要你先做决定
`;

function printHuman(result) {
	const lines = [];
	const ok = (v) => (v ? '✅' : '❌');

	lines.push('');
	lines.push('  outbox 发布报告');
	lines.push('  ' + '─'.repeat(56));

	if (result.repo) {
		lines.push(`  仓库      ${result.repo.url}`);
		lines.push(`  可见性    ${result.repo.visibility}${result.repo.created ? '（新建）' : '（复用已有）'}`);
	}
	if (result.commit?.sha) lines.push(`  提交      ${result.commit.sha.slice(0, 7)}`);
	if (typeof result.files === 'number') lines.push(`  文件      ${result.files} 个`);
	if (result.push?.verified) {
		lines.push(`  校验      ${ok(true)} 远端 SHA 与本地一致（${result.push.localSha?.slice(0, 7)}）`);
	} else if (result.push) {
		lines.push(`  校验      ${ok(false)} 本地 ${result.push.localSha?.slice(0, 7)} vs 远端 ${result.push.remoteSha?.slice(0, 7)}`);
	}

	lines.push('');
	lines.push('  执行过程');
	for (const step of result.steps ?? []) {
		lines.push(`    · ${step.name.padEnd(12)} ${step.detail}`);
	}

	if (result.scan?.blocked?.length > 0) {
		lines.push('');
		lines.push('  ⛔ 预检阻断（必须先处理）');
		for (const item of result.scan.blocked.slice(0, 20)) {
			lines.push(`    · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}`);
		}
	}
	if (result.scan?.confirm?.length > 0) {
		lines.push('');
		lines.push('  ⚠️  需要确认的敏感信息');
		for (const item of result.scan.confirm.slice(0, 20)) {
			lines.push(`    · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
		}
	}
	if (result.scan?.warn?.length > 0) {
		lines.push('');
		lines.push('  💡 提示（不阻断）');
		for (const item of result.scan.warn.slice(0, 10)) {
			lines.push(`    · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}`);
		}
	}

	if (result.message) {
		lines.push('');
		lines.push(`  ${result.message}`);
	}
	if (result.error) {
		lines.push('');
		lines.push(`  ❌ 失败于 ${result.error.step}：${result.error.reason ?? ''}`);
		if (result.error.detail) lines.push(`     ${String(result.error.detail).split('\n').slice(0, 5).join('\n     ')}`);
		if (result.error.hint) lines.push(`     ${result.error.hint}`);
	}

	lines.push('');
	return lines.join('\n');
}

function exitCodeFor(status) {
	switch (status) {
		case 'ok': return 0;
		case 'blocked': return 2;
		case 'needs_decision': return 3;
		case 'dry_run': return 0;
		default: return 1;
	}
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error.message}\n\n${USAGE}`);
		process.exit(1);
	}

	if (opts.flags.has('help')) {
		process.stdout.write(USAGE);
		process.exit(0);
	}

	const result = await publish({
		dir: opts.dir ?? process.cwd(),
		name: opts.name,
		visibility: opts.visibility,
		description: opts.description,
		message: opts.message,
		branch: opts.branch,
		proxyUrl: opts.proxy,
		proxyPort: opts['proxy-port'] ? Number(opts['proxy-port']) : undefined,
		timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
		dryRun: opts.flags.has('dry-run'),
	});

	if (opts.flags.has('json')) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		process.stdout.write(printHuman(result));
	}
	process.exit(exitCodeFor(result.status));
}

main().catch((error) => {
	process.stderr.write(`outbox 未预期错误：${error?.stack ?? error}\n`);
	process.exit(1);
});
