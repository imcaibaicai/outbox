#!/usr/bin/env node
/**
 * 把内核从主仓库同步进插件包。
 *
 * 为什么需要这一步：插件要能被单独安装（进插件市场），所以必须自带一份内核；
 * 但**真相源只能有一个** —— 就是仓库根目录的 src/outbox.mjs。让插件自己维护
 * 第二份逻辑，迟早会出现「CLI 能推、插件推不出去」这种最难查的不一致。
 * 所以插件里的那份是**机器生成的副本**，不是手写的第二实现。
 *
 * 用法：
 *   node scripts/sync-plugin.mjs           # 同步
 *   node scripts/sync-plugin.mjs --check   # 只校验是否已同步（不一致则退出码 1）
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'src', 'outbox.mjs');
const targetPath = path.join(root, 'dsh-plugin', 'lib', 'outbox.mjs');

const BANNER = [
	'// ⚠️ 本文件由 scripts/sync-plugin.mjs 从 src/outbox.mjs 自动同步生成，请勿直接编辑。',
	'// 真相源：<仓库根>/src/outbox.mjs —— 要改逻辑请改那里，然后重跑同步脚本。',
	'',
	'',
].join('\n');

const source = await fs.readFile(sourcePath, 'utf8');
const expected = BANNER + source;
const sourceHash = createHash('sha256').update(source).digest('hex');

const checkMode = process.argv.includes('--check');

let current = null;
try {
	current = await fs.readFile(targetPath, 'utf8');
} catch {
	current = null;
}

const inSync = current === expected;

if (checkMode) {
	if (inSync) {
		process.stdout.write(`插件内嵌内核已同步（sha256 ${sourceHash.slice(0, 16)}）\n`);
		process.exit(0);
	}
	process.stdout.write('❌ 插件内嵌内核与 src/outbox.mjs 不一致，请运行 node scripts/sync-plugin.mjs\n');
	process.exit(1);
}

await fs.mkdir(path.dirname(targetPath), { recursive: true });
await fs.writeFile(targetPath, expected, 'utf8');
process.stdout.write(`已同步内核 → dsh-plugin/lib/outbox.mjs（sha256 ${sourceHash.slice(0, 16)}）\n`);
