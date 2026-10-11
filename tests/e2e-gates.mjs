#!/usr/bin/env node
/**
 * outbox 安全闸门验收 —— 只验证「该拦的有没有拦住」，不创建任何远端仓库。
 *
 * 三个用例：
 *   A. 未明确可见性        → 必须停在 needs_decision，且远端未被创建
 *   B. 植入高危密钥        → 必须停在 blocked，且远端未被创建
 *   C. 请求公开 + 含敏感信息 → 必须停在 needs_decision（绝不自动公开）
 *
 * 验收判据不是「返回了某个状态」，而是「远端确实没有被创建」——用 gh 回读确认。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publish, buildChildEnv, detectProxy, getOwner, run } from '../src/outbox.mjs';

const results = [];
function check(name, passed, detail) {
	results.push({ name, passed: Boolean(passed), detail });
	process.stdout.write(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}\n`);
}

const proxy = await detectProxy();
const env = buildChildEnv(proxy);
const owner = await getOwner(env, { timeoutMs: 60_000 });
check('能取到 owner', typeof owner === 'string' && owner.length > 0, `owner=${owner}`);

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-gates-'));
const GATE_NAME = 'outbox-e2e-gate-check';

/** 远端不存在才算通过 —— 这是「什么都没推出去」的硬证据。 */
async function assertNoRemote(label) {
	const view = await run('gh', ['repo', 'view', `${owner}/${GATE_NAME}`, '--json', 'name'], { env, timeoutMs: 60_000 });
	check(`${label}：远端确认未被创建`, view.code !== 0, `gh repo view 退出码 ${view.code}`);
}

/* ---------------- 用例 A：未明确可见性 ---------------- */

const dirA = path.join(tmpRoot, 'case-a');
await fs.mkdir(dirA, { recursive: true });
await fs.writeFile(path.join(dirA, 'README.md'), '# case a\n\n干净内容。\n', 'utf8');

const resultA = await publish({ dir: dirA, name: GATE_NAME, visibility: 'ask' });
check('A. 未明确可见性 → needs_decision', resultA.status === 'needs_decision', `status=${resultA.status}`);
check('A. 没有提交（不该产生提交）', resultA.commit === undefined, `commit=${JSON.stringify(resultA.commit ?? null)}`);
await assertNoRemote('A');

/* ---------------- 用例 B：植入高危密钥 ---------------- */

const dirB = path.join(tmpRoot, 'case-b');
await fs.mkdir(dirB, { recursive: true });
await fs.writeFile(path.join(dirB, 'README.md'), '# case b\n', 'utf8');
await fs.writeFile(
	path.join(dirB, 'config.js'),
	'const token = "ghp_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";\n',
	'utf8',
);

const resultB = await publish({ dir: dirB, name: GATE_NAME, visibility: 'private' });
check('B. 植入密钥 → blocked', resultB.status === 'blocked', `status=${resultB.status}`);
check('B. 命中的确实是 GitHub 令牌规则', resultB.scan?.blocked?.some((x) => x.rule === 'github-token') === true, JSON.stringify(resultB.scan?.blocked?.map((x) => x.rule)));
check('B. 已列出命中文件', resultB.scan?.blocked?.some((x) => x.file === 'config.js') === true);
await assertNoRemote('B');

/* ---------------- 用例 C：请求公开但含敏感信息 ---------------- */

const dirC = path.join(tmpRoot, 'case-c');
await fs.mkdir(dirC, { recursive: true });
await fs.writeFile(path.join(dirC, 'README.md'), '# case c\n\n本地路径 D:\\Users\\somebody\\proj\n', 'utf8');

const resultC = await publish({ dir: dirC, name: GATE_NAME, visibility: 'public' });
check('C. 请求公开但含敏感信息 → needs_decision', resultC.status === 'needs_decision', `status=${resultC.status}`);
check('C. 给出了降级到 private 的建议', resultC.proposed?.visibility === 'private', `proposed=${JSON.stringify(resultC.proposed ?? null)}`);
check('C. 没有提交', resultC.commit === undefined);
await assertNoRemote('C');

/* ---------------- 用例 D：干净 + private + dry-run ---------------- */

const dirD = path.join(tmpRoot, 'case-d');
await fs.mkdir(dirD, { recursive: true });
await fs.writeFile(path.join(dirD, 'README.md'), '# case d\n\n干净内容。\n', 'utf8');

const resultD = await publish({ dir: dirD, name: GATE_NAME, visibility: 'private', dryRun: true });
check('D. dry-run → dry_run 状态', resultD.status === 'dry_run', `status=${resultD.status}`);
check('D. dry-run 不提交', resultD.commit === undefined);
await assertNoRemote('D');

/* ---------------- 收尾 ---------------- */

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

await fs.writeFile(
	path.join(import.meta.dirname, '_e2e_gates_result.json'),
	JSON.stringify({ summary: { total: results.length, passed, failed }, results }, null, 2),
	'utf8',
);

process.stdout.write(`\n${passed}/${results.length} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
