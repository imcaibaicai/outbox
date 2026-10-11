/**
 * dsh-github-push —— 把 outbox 内核注册成 DSH 的模型工具，实现「一句话推送」。
 *
 * 这一层刻意做得极薄：只做参数校验与结果渲染。全部硬逻辑都在同目录的
 * outbox.mjs —— 它由主仓库的 scripts/sync-plugin.mjs 自动同步而来，
 * 保证插件、CLI、SKILL.md 走的是同一份代码，不会出现「CLI 能推、插件推不出去」。
 *
 * 注册的工具名是 `github_push`。
 */

import path from 'node:path';
import { publish } from './outbox.mjs';

/** 插件在 cordis loader 里的行 id 也用这个名字。 */
export const name = 'dsh-github-push';

const outputText = {
	schema: { type: 'string' },
	render: (_args, value) => [{ type: 'text', text: value }],
};

/** 把内核返回的结构化结果渲染成给模型看的中文报告。 */
function renderReport(result) {
	const lines = [];

	switch (result.status) {
		case 'ok':
			lines.push('✅ 推送成功');
			break;
		case 'dry_run':
			lines.push('🔎 干跑完成（未提交、未推送）');
			break;
		case 'blocked':
			lines.push('⛔ 预检阻断：发现高危内容，远端仓库未被创建、未提交、未推送');
			break;
		case 'needs_decision':
			lines.push('🟡 需要用户确认后才能继续（远端仓库尚未创建）');
			break;
		default:
			lines.push('❌ 执行失败');
	}

	if (result.repo) {
		lines.push('');
		lines.push(`仓库：${result.repo.url}`);
		lines.push(`可见性：${result.repo.visibility}${result.repo.created ? '（新建）' : '（复用已有）'}`);
	}
	if (result.commit?.sha) lines.push(`提交：${result.commit.sha.slice(0, 7)}`);
	if (typeof result.files === 'number') lines.push(`文件：${result.files} 个`);
	if (result.push?.verified === true) {
		lines.push(`校验：✅ 远端 SHA 与本地一致（${result.push.localSha?.slice(0, 7)}）`);
	} else if (result.push && result.push.localSha) {
		lines.push(`校验：❌ 不一致（本地 ${result.push.localSha?.slice(0, 7)} / 远端 ${result.push.remoteSha?.slice(0, 7)}）`);
	}

	if (result.status === 'needs_decision') {
		const proposed = result.proposed ?? {};
		lines.push('');
		lines.push('请就下面这几点问用户，拿到答复后用明确的 visibility 再调用一次：');
		if (proposed.name) lines.push(`  · 仓库名：${proposed.name}`);
		lines.push(`  · 可见性：public 还是 private？${proposed.reason ? `（原因：${proposed.reason}）` : ''}`);
	}

	if (result.scan?.blocked?.length > 0) {
		lines.push('');
		lines.push('⛔ 预检阻断清单（逐条处理后重试，不要绕过）：');
		for (const item of result.scan.blocked.slice(0, 20)) {
			lines.push(`  · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
		}
	}
	if (result.scan?.confirm?.length > 0) {
		lines.push('');
		lines.push('⚠️ 命中个人信息，公开前必须逐条确认：');
		for (const item of result.scan.confirm.slice(0, 20)) {
			lines.push(`  · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
		}
	}
	if (result.scan?.warn?.length > 0) {
		lines.push('');
		lines.push('💡 提示（不阻断）：');
		for (const item of result.scan.warn.slice(0, 10)) {
			lines.push(`  · ${item.file}${item.line ? `:${item.line}` : ''}  ${item.label}`);
		}
	}
	if (result.scan?.allowlisted?.length > 0) {
		lines.push(`（另有 ${result.scan.allowlisted.length} 处命中被 .outboxallow / 行内标记放行）`);
	}

	if (result.steps?.length > 0) {
		lines.push('');
		lines.push('执行过程：');
		for (const step of result.steps) lines.push(`  · ${step.name}：${step.detail}`);
	}

	if (result.error) {
		lines.push('');
		lines.push(`❌ 失败于 ${result.error.step}：${result.error.reason ?? ''}`);
		if (result.error.detail) lines.push(`   ${String(result.error.detail).split('\n').slice(0, 5).join('\n   ')}`);
		if (result.error.hint) lines.push(`   ${result.error.hint}`);
	}

	return lines.join('\n');
}

const toolDef = {
	name: 'github_push',
	description:
		'把本地目录可靠地推送到 GitHub，一条指令走完：代理探测（默认 127.0.0.1:7890，按次注入不写全局配置）→ 从系统凭据管理器自愈 gh 登录态 → 推送前扫描密钥与个人敏感信息 → 建仓/提交/推送 → 回读远端分支 SHA 校验。' +
		'用户说「推送到 GitHub」「开源这个项目」「发到 GitHub 上」「帮我建个仓库推上去」时使用。' +
		'visibility 必须如实反映用户意图，不得替用户决定：用户明确说公开/开源/public 才传 public；明确说私有/private 才传 private；其它情况一律传 ask —— 传 ask 时不会创建任何远端仓库，只做预检并返回需要确认的问题。' +
		'若返回 blocked，说明真的扫到了密钥，必须逐条处理后重试，不要试图绕过。',
	parameters: {
		type: 'object',
		additionalProperties: false,
		properties: {
			dir: {
				type: 'string',
				description: '要发布的本地目录，必须是绝对路径（相对路径会解析到宿主进程的工作目录，通常不是你想要的目录）。',
			},
			visibility: {
				type: 'string',
				enum: ['public', 'private', 'ask'],
				description: '必填。public=用户明确要开源；private=用户明确要私有；ask=用户没明确说，工具会返回需要确认的问题。',
			},
			name: { type: 'string', description: '远端仓库名。省略时由目录名规整而来。' },
			description: { type: 'string', description: 'GitHub 上的仓库描述。' },
			message: { type: 'string', description: '提交信息。' },
			dryRun: { type: 'boolean', description: '只做预检，不提交、不推送。新仓库建议先跑一次。' },
		},
		required: ['dir', 'visibility'],
	},
	output: outputText,
	async execute(args) {
		const dir = typeof args?.dir === 'string' ? args.dir.trim() : '';
		if (dir.length === 0) return '失败：dir 不能为空。';

		// 相对路径会被解析到宿主进程的工作目录，而不是会话工作区 —— 那会把错误的
		// 目录推上 GitHub。宁可在这里明确拒绝，也不要默默推错东西。
		if (!path.isAbsolute(dir)) {
			return `失败：dir 必须是绝对路径，收到的是「${dir}」。相对路径会解析到宿主进程的工作目录，可能推错目录。`;
		}

		const visibility = args?.visibility;
		if (!['public', 'private', 'ask'].includes(visibility)) {
			return '失败：visibility 只能是 public / private / ask。若用户没有明确说公开还是私有，请传 ask。';
		}

		try {
			const result = await publish({
				dir,
				visibility,
				name: typeof args?.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : undefined,
				description: typeof args?.description === 'string' ? args.description : undefined,
				message: typeof args?.message === 'string' && args.message.trim().length > 0 ? args.message.trim() : undefined,
				dryRun: args?.dryRun === true,
			});
			return renderReport(result);
		} catch (error) {
			return `失败：outbox 内核抛出未预期错误 —— ${error?.message ?? error}`;
		}
	},
};

export function apply(ctx) {
	ctx.tools.register(toolDef);
}

/** 测试用：暴露内部实现，便于在无 DSH 环境下做冒烟验证。 */
export const __test = { toolDef, renderReport };
