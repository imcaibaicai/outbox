#!/usr/bin/env node
/**
 * dsh-github-push 插件冒烟测试 —— 不依赖 DSH 运行时。
 *
 * 验证四件事：
 *   1. apply() 确实注册了一个名为 github_push 的工具，参数契约正确
 *   2. 参数校验挡得住会导致「推错目录」的输入（相对路径）
 *   3. 非法 visibility 被拒绝（防止模型乱传值绕过可见性规则）
 *   4. 能真跑一次 dry-run 并渲染出报告（只读，无远端写入）
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, __test } from '../dsh-plugin/lib/index.js';

const results = [];
function check(name, passed, detail) {
	results.push({ name, passed: Boolean(passed), detail });
	process.stdout.write(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}\n`);
}

/* ---------------- 1. 注册与参数契约 ---------------- */

let registered = null;
const fakeCtx = {
	tools: {
		register(def) {
			registered = def;
		},
	},
};

apply(fakeCtx);

check('apply() 注册了 github_push 工具', registered !== null && registered.name === 'github_push', registered?.name ?? '(未注册)');
check(
	'工具声明了模型可见的描述',
	typeof registered?.description === 'string' && registered.description.length > 100,
	`长度 ${registered?.description?.length ?? 0}`,
);
check(
	'required 恰为 dir 与 visibility',
	JSON.stringify(registered?.parameters?.required) === JSON.stringify(['dir', 'visibility']),
	JSON.stringify(registered?.parameters?.required),
);
check(
	'visibility 被限定为 public/private/ask',
	JSON.stringify(registered?.parameters?.properties?.visibility?.enum) === JSON.stringify(['public', 'private', 'ask']),
	JSON.stringify(registered?.parameters?.properties?.visibility?.enum),
);
check('声明了 output.render', typeof registered?.output?.render === 'function');
check('工具名与 __test 暴露一致', __test.toolDef.name === registered.name);

/* ---------------- 2. 参数校验（不触网） ---------------- */

const r1 = await registered.execute({});
check('空 dir 被拒绝', r1.includes('dir 不能为空'), r1.split('\n')[0]);

const r2 = await registered.execute({ dir: 'relative/path', visibility: 'public' });
check('相对路径被拒绝（防止推错目录）', r2.includes('必须是绝对路径'), r2.split('\n')[0]);

const r3 = await registered.execute({ dir: path.resolve('.'), visibility: 'maybe' });
check('非法 visibility 被拒绝', r3.includes('只能是 public / private / ask'), r3.split('\n')[0]);

const r4 = await registered.execute({ dir: path.resolve('.'), visibility: undefined });
check('缺 visibility 时给出明确提示', r4.includes('visibility'), r4.split('\n')[0]);

/* ---------------- 3. 真跑一次 dry-run（只读） ---------------- */

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-plugin-'));
await fs.writeFile(path.join(tmp, 'README.md'), '# plugin smoke\n\n干净内容。\n', 'utf8');

const r5 = await registered.execute({ dir: tmp, visibility: 'private', dryRun: true });
check('dry-run 走通并渲染报告', r5.includes('干跑完成'), r5.split('\n')[0]);
check('报告里有执行过程', r5.includes('执行过程'), `长度 ${r5.length}`);
check('dry-run 不应出现远端仓库信息', !r5.includes('仓库：http'), r5.split('\n').slice(0, 4).join(' / '));

// 未明确可见性 → 必须停在需要确认，且不得创建远端仓库
const r6 = await registered.execute({ dir: tmp, visibility: 'ask' });
check('visibility=ask 时停在需要确认', r6.includes('需要用户确认'), r6.split('\n')[0]);
check('需要确认时给出要问用户的要点', r6.includes('可见性：public 还是 private'), '—');

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

/* ---------------- 收尾 ---------------- */

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

await fs.writeFile(
	path.join(import.meta.dirname, '_plugin_smoke_result.json'),
	JSON.stringify({ summary: { total: results.length, passed, failed }, results }, null, 2),
	'utf8',
);

process.stdout.write(`\n${passed}/${results.length} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
