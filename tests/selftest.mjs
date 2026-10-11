#!/usr/bin/env node
/**
 * outbox 自测 —— 只验证内核的确定行为，不碰任何远端。
 *
 * 覆盖四件最容易写错的事：
 *   1. 代理探测，以及代理环境的「注入 / 清理陈旧变量」两条分支
 *   2. 预检扫描能否抓到植入的假密钥（必须阻断）
 *   3. 预检扫描能否抓到会暴露身份的绝对路径与个人信息（必须待确认）
 *   4. .gitignore 覆盖的文件不得被误报（扫描的是索引，不是目录）
 *
 * 结果同时写进 tests/_selftest_result.json，便于在中文控制台乱码时直接查看。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULTS,
	detectProxy,
	buildChildEnv,
	gitProxyArgs,
	scanStaged,
	ensureGhAuth,
	getOwner,
	ensureLocalRepo,
	stageAll,
	suggestRepoName,
	redact,
	run,
	__internal,
} from '../src/outbox.mjs';

const results = [];
function check(name, passed, detail) {
	results.push({ name, passed: Boolean(passed), detail });
	const mark = passed ? 'PASS' : 'FAIL';
	process.stdout.write(`[${mark}] ${name}${detail ? ` -- ${detail}` : ''}\n`);
}

/* ------------------------------------------------------------------ *
 * 1. 代理探测与环境构造
 * ------------------------------------------------------------------ */

const proxy = await detectProxy();
check('代理探测：7890 可达', proxy.reachable === true, `reachable=${proxy.reachable} url=${proxy.url}`);

const envOn = buildChildEnv(proxy, { HTTP_PROXY: 'http://127.0.0.1:7890', PATH: '/x' });
check(
	'代理可达时按次注入',
	envOn.HTTPS_PROXY === proxy.url && envOn.GIT_TERMINAL_PROMPT === '0',
	`HTTPS_PROXY=${envOn.HTTPS_PROXY} GIT_TERMINAL_PROMPT=${envOn.GIT_TERMINAL_PROMPT}`,
);

const deadProxy = { reachable: false, host: '127.0.0.1', port: 7890, url: 'http://127.0.0.1:7890' };
const envOff = buildChildEnv(deadProxy, { HTTPS_PROXY: 'http://127.0.0.1:7890', PATH: '/x' }, {});
check(
	'代理不可达时清掉指向该端口的陈旧变量',
	envOff.HTTPS_PROXY === undefined && envOff.http_proxy === undefined,
	`HTTPS_PROXY=${envOff.HTTPS_PROXY}`,
);

const envKeep = buildChildEnv(deadProxy, { HTTPS_PROXY: 'http://corp.example:8080', PATH: '/x' }, {});
check(
	'代理不可达时保留指向别处的代理设置',
	envKeep.HTTPS_PROXY === 'http://corp.example:8080',
	`HTTPS_PROXY=${envKeep.HTTPS_PROXY}`,
);

check('git 代理参数按次生成', gitProxyArgs(proxy).join(' ').includes('http.proxy=http://127.0.0.1:7890'), gitProxyArgs(proxy).join(' '));
check('代理关闭时不产生 git 代理参数', gitProxyArgs(deadProxy).length === 0);

/* ------------------------------------------------------------------ *
 * 2. 纯函数
 * ------------------------------------------------------------------ */

check('仓库名规整化', suggestRepoName('D:\\x\\My Cool Project!') === 'my-cool-project', suggestRepoName('D:\\x\\My Cool Project!'));
check('仓库名规整化（中文目录）', suggestRepoName('D:\\x\\我的项目') === 'new-repo' || /^[a-z0-9._-]+$/.test(suggestRepoName('D:\\x\\我的项目')), suggestRepoName('D:\\x\\我的项目'));

__internal.rememberSecret('ghp_SUPERSECRETVALUE1234567890');
check('敏感串脱敏', !redact('token=ghp_SUPERSECRETVALUE1234567890 end').includes('ghp_SUPERSECRETVALUE'), redact('token=ghp_SUPERSECRETVALUE1234567890 end'));
check('凭据解析', __internal.parseCredentialPassword('protocol=https\nhost=github.com\nusername=u\npassword=abc12345\n') === 'abc12345');
check('gh 账号解析', __internal.parseGhAccount('Logged in to github.com account someuser (keyring)') === 'someuser');

/* ------------------------------------------------------------------ *
 * 3. 预检扫描（在临时仓库里植入假目标）
 * ------------------------------------------------------------------ */

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-selftest-'));
const testDir = path.join(tmpRoot, 'sample-project');
await fs.mkdir(testDir, { recursive: true });

// 先写 .gitignore，再写被忽略的文件，验证「忽略项不误报」
await fs.writeFile(path.join(testDir, '.gitignore'), '*.env\nnode_modules/\n', 'utf8');
await fs.writeFile(path.join(testDir, 'secret.env'), 'GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n', 'utf8');

// 干净文件
await fs.writeFile(path.join(testDir, 'README.md'), '# sample\n\n一个干净的示例项目。\n', 'utf8');

// 植入假密钥（必须阻断）
await fs.writeFile(
	path.join(testDir, 'leaked-config.js'),
	[
		'const a = "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";',
		'const b = "sk-CCCCCCCCCCCCCCCCCCCCCCCC";',
		'const c = "AKIAIOSFODNN7EXAMPLE";',
	].join('\n'),
	'utf8',
);

// 植入私钥文件（文件名规则必须阻断）
await fs.writeFile(path.join(testDir, 'server.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n', 'utf8');

// 植入会暴露身份的内容（必须进入待确认，且不允许自动公开）
await fs.writeFile(
	path.join(testDir, 'notes.md'),
	[
		'本地路径 D:\\Users\\somebody\\work\\proj',
		'另一处 /home/somebody/proj',
		'学号: 2023123456',
	].join('\n'),
	'utf8',
);

const env = buildChildEnv(proxy);
const localRepo = await ensureLocalRepo(testDir, env);
check('临时仓库初始化成功', localRepo.ok === true, localRepo.reason ?? `created=${localRepo.created}`);

await stageAll(testDir, env);
const scan = await scanStaged(testDir, env);

const blockedRules = new Set(scan.blocked.map((x) => x.rule));
const confirmRules = new Set(scan.confirm.map((x) => x.rule));
const blockedFiles = new Set(scan.blocked.map((x) => x.file));

check('扫描到 GitHub 令牌', blockedRules.has('github-token'), [...blockedRules].join(','));
check('扫描到 OpenAI 风格密钥', blockedRules.has('openai-key'));
check('扫描到 AWS Key', blockedRules.has('aws-access-key'));
check('扫描到私钥文件', blockedRules.has('pem-key'));
check('命中高危时会阻断', scan.blocked.length > 0, `blocked=${scan.blocked.length}`);
check('.gitignore 覆盖的文件不被误报', !blockedFiles.has('secret.env'), [...blockedFiles].join(','));
check('抓到会暴露身份的绝对路径', confirmRules.has('win-user-path') || confirmRules.has('nix-user-path'), [...confirmRules].join(','));
check('抓到疑似学号字段', confirmRules.has('student-id-hint'), [...confirmRules].join(','));
check('干净文件不产生告警', !scan.blocked.some((x) => x.file === 'README.md') && !scan.confirm.some((x) => x.file === 'README.md'));

/* ------------------------------------------------------------------ *
 * 3.5 放行清单与行内标记
 *
 * 背景：本仓库自己的测试夹具就含假密钥，所以必须有出口 —— 否则 outbox
 * 会被自己的闸门拦住（第一次推送时确实如此）。
 * ------------------------------------------------------------------ */

const allowDir = path.join(tmpRoot, 'case-allow');
await fs.mkdir(allowDir, { recursive: true });
await fs.writeFile(path.join(allowDir, 'README.md'), '# allow\n', 'utf8');

// 行内标记：与假密钥同一行，该行必须被跳过
await fs.writeFile(
	path.join(allowDir, 'inline.js'),
	'const a = "ghp_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"; // outbox:allow\n',
	'utf8',
);
// 无标记：必须被抓住
await fs.writeFile(
	path.join(allowDir, 'listed.js'),
	'const b = "ghp_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";\n',
	'utf8',
);

await ensureLocalRepo(allowDir, env);
await stageAll(allowDir, env);

const scanBefore = await scanStaged(allowDir, env);
const beforeBlocked = new Set(scanBefore.blocked.map((x) => x.file));
check('行内 outbox:allow 标记的行被跳过', !beforeBlocked.has('inline.js'), `blocked=${[...beforeBlocked].join(',')}`);
check('无标记的夹具仍被抓住', beforeBlocked.has('listed.js'), `blocked=${[...beforeBlocked].join(',')}`);

// 追加一个「未被放行」的夹具，用来验证放行范围是精确的，而不是一刀切
await fs.writeFile(path.join(allowDir, 'other.js'), 'const c = "AKIAIOSFODNN7EXAMPLE";\n', 'utf8');

// 加上仓库级放行清单后：listed.js 应被豁免，且命中转入 allowlisted（可见，而非静默吞掉）
await fs.writeFile(path.join(allowDir, '.outboxallow'), 'listed.js github-token\n', 'utf8');
await stageAll(allowDir, env);

const scanAfter = await scanStaged(allowDir, env);
const afterBlocked = new Set(scanAfter.blocked.map((x) => `${x.file}[${x.rule}]`));
check(
	'放行清单生效：listed.js 不再阻断',
	!afterBlocked.has('listed.js[github-token]'),
	`blocked=${[...afterBlocked].join(',')}`,
);
check(
	'被放行的命中转入 allowlisted 保持可见',
	scanAfter.allowlisted.some((x) => x.file === 'listed.js' && x.rule === 'github-token'),
	scanAfter.allowlisted.map((x) => `${x.file}[${x.rule}]`).join(', ') || '(空)',
);
check(
	'放行范围精确：未放行的规则仍然生效',
	afterBlocked.has('other.js[aws-access-key]'),
	`blocked=${[...afterBlocked].join(',')}`,
);

/* ------------------------------------------------------------------ *
 * 3.6 已跟踪、却已被 gitignore 覆盖的残留
 *
 * 这类残留最阴险：.gitignore 只对「未跟踪」文件生效，文件一旦提交过就永远
 * 跟着走。outbox 第一次真实推送时就是这样把 tests/_push_result.txt 送上去的。
 * ------------------------------------------------------------------ */

const staleDir = path.join(tmpRoot, 'case-stale');
await fs.mkdir(staleDir, { recursive: true });
await fs.writeFile(path.join(staleDir, 'README.md'), '# stale\n', 'utf8');
await fs.writeFile(path.join(staleDir, 'temp-output.txt'), 'build artifact\n', 'utf8');

await ensureLocalRepo(staleDir, env);
await stageAll(staleDir, env);
// 先提交，模拟「历史上已经被提交过」
const staleCommit = await run('git', ['commit', '-m', 'add temp output'], { cwd: staleDir, env });
check('残留用例：预置提交成功', staleCommit.code === 0, `code=${staleCommit.code} ${staleCommit.stderr.trim().slice(0, 80)}`);

// 之后才把它写进忽略规则
await fs.writeFile(path.join(staleDir, '.gitignore'), 'temp-output.txt\n', 'utf8');
await stageAll(staleDir, env);

const staleScan = await scanStaged(staleDir, env);
check(
	'检出「已跟踪但已被 gitignore 覆盖」的残留',
	staleScan.warn.some((x) => x.rule === 'tracked-but-ignored' && x.file === 'temp-output.txt'),
	staleScan.warn.map((x) => `${x.file}[${x.rule}]`).join(', ') || '(空)',
);

/* ------------------------------------------------------------------ *
 * 4. 非 ASCII 路径（Windows OEM 编码坑的回归用例）
 *    本机用户目录就是中文，任何一处编码退化都会在这里立刻暴露。
 * ------------------------------------------------------------------ */

const cnDir = path.join(tmpRoot, '测试项目');
await fs.mkdir(cnDir, { recursive: true });
await fs.writeFile(path.join(cnDir, '说明文档.md'), '这是一个中文文件名下的干净文件。\n', 'utf8');
await fs.writeFile(
	path.join(cnDir, '泄露配置.txt'),
	'token = "ghp_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"\n',
	'utf8',
);

const cnRepo = await ensureLocalRepo(cnDir, env);
check('中文路径仓库初始化成功', cnRepo.ok === true, cnRepo.reason ?? `created=${cnRepo.created}`);

await stageAll(cnDir, env);
const cnScan = await scanStaged(cnDir, env);
check(
	'中文文件名能正确列出并读取',
	cnScan.ok === true && cnScan.totalFiles >= 2 && cnScan.scannedFiles >= 2,
	`totalFiles=${cnScan.totalFiles} scanned=${cnScan.scannedFiles}`,
);
check(
	'中文路径下的密钥同样被抓住',
	cnScan.blocked.some((x) => x.rule === 'github-token'),
	cnScan.blocked.map((x) => `${x.file}[${x.rule}]`).join(', ') || '(未命中)',
);

/* ------------------------------------------------------------------ *
 * 5. gh 登录态与账号读取（只读操作）
 * ------------------------------------------------------------------ */

const auth = await ensureGhAuth(env, { timeoutMs: 60_000 });
check('gh 登录态可用', auth.ok === true, auth.ok ? `account=${auth.account} healed=${auth.healed}` : auth.reason);

const owner = await getOwner(env, { timeoutMs: 60_000 });
check('能动态取到 owner（不写死账号）', typeof owner === 'string' && owner.length > 0, `owner=${owner}`);

// 这条断言最初写的是「远端 outbox 尚未占用」——首次推送成功后仓库已存在，
// 那个断言就永久过期了。改成持久有意义的：能通过 gh 读到远端仓库元数据，
// 证明 API 通路、凭据与权限都正常。
const repoView = await run('gh', ['repo', 'view', `${owner}/outbox`, '--json', 'name,visibility,url'], { env, timeoutMs: 60_000 });
check('gh 能读到远端仓库元数据', repoView.code === 0, repoView.code === 0 ? repoView.stdout.trim() : `退出码 ${repoView.code}`);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

const outFile = path.join(import.meta.dirname, '_selftest_result.json');
await fs.writeFile(
	outFile,
	JSON.stringify({ summary: { total: results.length, passed, failed }, proxyPort: DEFAULTS.proxyPort, results }, null, 2),
	'utf8',
);

process.stdout.write(`\n${passed}/${results.length} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
