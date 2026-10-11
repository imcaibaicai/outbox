/**
 * outbox 内核 —— 把本地目录可靠地送上 GitHub 的唯一真逻辑层。
 *
 * 设计原则
 * ---------------------------------------------------------------------------
 * 1. **一份内核，两种外壳**：本文件是唯一真相源。SKILL.md（Agent 通用外壳）与
 *    DSH 插件（dsh-github-push）都只调用它，绝不各自复制一份逻辑——两份逻辑
 *    迟早行为不一致，那正是「推送有 bug」的来源。
 * 2. **零依赖**：只用 Node 内置模块。这样 DSH 插件可以直接 `import` 本模块、
 *    在同一个 Node 进程里跑，不需要子进程、不需要查 PATH、不需要处理引号转义。
 * 3. **不写死任何账号**：owner 一律运行时用 `gh api user` 取，既守隐私也便于他人使用。
 * 4. **代理按次注入**：绝不写 git 全局配置，只在本次命令上用 `-c http.proxy=`。
 *    端口探不通时，只清掉指向该端口的陈旧代理变量后直连，不碰别人的代理设置。
 * 5. **密钥永不落日志**：token 只在内存里流转；所有返回的 stdout/stderr 都过 redact()。
 * 6. **一切结论带证据**：推送成功的判据不是命令退出码，而是远端 SHA == 本地 SHA。
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ *
 * 默认配置
 * ------------------------------------------------------------------ */

export const DEFAULTS = {
	/** 代理探测端口：用户指定的 7890。 */
	proxyPort: 7890,
	proxyHost: '127.0.0.1',
	/** 单条子命令超时（毫秒）。推送大仓库需要放宽。 */
	timeoutMs: 300_000,
	/** 代理探测超时（毫秒）。够短，避免卡住。 */
	proxyProbeTimeoutMs: 400,
	/** 默认分支名。 */
	branch: 'main',
	/** 超过此大小记 warn（10 MiB）。 */
	largeFileWarnBytes: 10 * 1024 * 1024,
	/** 超过此大小记 block —— GitHub 单文件硬上限 100 MiB（95 MiB 留余量）。 */
	largeFileBlockBytes: 95 * 1024 * 1024,
	/** 内容扫描单文件上限，超过只做尺寸检查（2 MiB）。 */
	scanMaxBytes: 2 * 1024 * 1024,
};

/* ------------------------------------------------------------------ *
 * 密钥脱敏
 * ------------------------------------------------------------------ */

/** 运行期收集到的敏感串，任何回传文本都要先过滤掉它们。 */
const SECRETS = new Set();

/** 把已知敏感串替换成 ***。 */
export function redact(text) {
	if (typeof text !== 'string' || text.length === 0) return text;
	let out = text;
	for (const secret of SECRETS) {
		if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join('***');
	}
	return out;
}

/** 登记一个敏感串（只登记，不返回，调用方拿不到明文回显）。 */
function rememberSecret(value) {
	if (typeof value === 'string' && value.length >= 8) SECRETS.add(value);
}

/* ------------------------------------------------------------------ *
 * 子进程执行
 * ------------------------------------------------------------------ */

/** 可执行文件路径缓存。 */
const binCache = new Map();

/**
 * 解析可执行文件。
 *
 * ⚠️ 血泪教训：**不要解析 `where.exe` 的输出来定位程序**。
 * Windows 控制台工具按 OEM 代码页（简体中文机器是 CP936）输出，而 Node 按 UTF-8
 * 解码 —— 只要可执行文件路径里含中文（本机 %USERPROFILE% 就含中文用户名），
 * 解析结果就会变成一串 U+FFFD 替换字符，随后 spawn 报 ENOENT。
 * 更阴险的是：Git 通常装在纯 ASCII 路径下所以一切正常，于是这个 bug 只会在
 * 「用户名是中文」的机器上爆发 —— 典型的「在我机器上好好的」。
 *
 * 正确做法：把裸名字直接交给 Windows，由它按 PATH + PATHEXT 自己解析。
 * 需要强制指定时，用环境变量 OUTBOX_GIT / OUTBOX_GH 给出绝对路径。
 */
async function resolveBin(name) {
	if (binCache.has(name)) return binCache.get(name);
	const override = process.env[`OUTBOX_${name.toUpperCase()}`];
	const resolved = typeof override === 'string' && override.trim().length > 0 ? override.trim() : name;
	binCache.set(name, resolved);
	return resolved;
}

/**
 * 跑一条子命令并完整收集输出。
 * 永不 reject：把失败表达成 { code, stdout, stderr }，让上层按业务判断，
 * 避免到处 try/catch 把真实错误吞掉。
 */
export async function run(command, args, options = {}) {
	const {
		cwd,
		env,
		input,
		timeoutMs = DEFAULTS.timeoutMs,
		binName,
	} = options;

	const bin = binName === undefined ? await resolveBin(command) : command;

	return await new Promise((resolve) => {
		let child;
		try {
			child = spawn(bin, args, {
				cwd,
				env: env ?? process.env,
				shell: false,
				windowsHide: true,
			});
		} catch (error) {
			resolve({ code: -1, stdout: '', stderr: redact(String(error?.message ?? error)), spawnError: true });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timedOut = false;

		const finish = (code, extra = {}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code,
				stdout: redact(stdout),
				stderr: redact(stderr),
				timedOut,
				command: `${command} ${args.join(' ')}`,
				...extra,
			});
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* 忽略：进程可能已经退出 */
			}
		}, timeoutMs);

		child.stdout?.on('data', (chunk) => (stdout += chunk.toString('utf8')));
		child.stderr?.on('data', (chunk) => (stderr += chunk.toString('utf8')));
		child.on('error', (error) => {
			stderr += String(error?.message ?? error);
			finish(-1, { spawnError: true });
		});
		child.on('close', (code) => finish(code ?? -1));

		try {
			if (input !== undefined) child.stdin.end(input);
			else child.stdin.end();
		} catch {
			/* stdin 可能已关闭 */
		}
	});
}

/* ------------------------------------------------------------------ *
 * 代理
 * ------------------------------------------------------------------ */

/** 探测某个本地端口是否在监听（TCP 连得上即视为代理可用）。 */
export async function detectProxy(options = {}) {
	const host = options.host ?? DEFAULTS.proxyHost;
	const port = options.port ?? DEFAULTS.proxyPort;
	const timeoutMs = options.timeoutMs ?? DEFAULTS.proxyProbeTimeoutMs;

	const reachable = await new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				/* 忽略 */
			}
			resolve(value);
		};
		const socket = createConnection({ host, port });
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});

	return {
		reachable,
		host,
		port,
		url: `http://${host}:${port}`,
	};
}

/** 所有可能承载代理设置的变量名。 */
const PROXY_ENV_KEYS = [
	'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
	'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

/**
 * 为子进程构造环境：按探测结果注入或清理代理。
 *
 * 关键取舍：端口不通时**只清掉指向该端口的陈旧变量**。如果用户的代理配置指向
 * 别处（例如公司网关），那多半仍然有效，不该被我们擅自删掉。
 */
export function buildChildEnv(proxy, base = process.env, extra = {}) {
	const env = { ...base, ...extra };

	// 永不交互挂起：宁可失败得清清楚楚，也不要卡在等输入上。
	env.GIT_TERMINAL_PROMPT = '0';
	env.GCM_INTERACTIVE = 'never';

	const staleUrls = [`http://${proxy.host}:${proxy.port}`, `https://${proxy.host}:${proxy.port}`];
	// 也把 localhost 写法的等价形式算进去。
	const aliasUrls = [`http://localhost:${proxy.port}`, `https://localhost:${proxy.port}`];

	for (const key of PROXY_ENV_KEYS) {
		const current = env[key];
		if (typeof current !== 'string' || current.length === 0) continue;
		const isStale = [...staleUrls, ...aliasUrls].some((u) => current.startsWith(u));
		if (proxy.reachable && (key.toLowerCase() === 'http_proxy' || key.toLowerCase() === 'https_proxy')) {
			// 由下面的显式赋值覆盖
			continue;
		}
		if (!proxy.reachable && isStale) delete env[key];
	}

	if (proxy.reachable) {
		env.HTTP_PROXY = proxy.url;
		env.HTTPS_PROXY = proxy.url;
		env.http_proxy = proxy.url;
		env.https_proxy = proxy.url;
	}

	return env;
}

/** 生成 git 的按次代理参数（不落全局配置）。 */
export function gitProxyArgs(proxy) {
	if (!proxy?.reachable) return [];
	return ['-c', `http.proxy=${proxy.url}`, '-c', `https.proxy=${proxy.url}`];
}

/* ------------------------------------------------------------------ *
 * 预检扫描
 * ------------------------------------------------------------------ */

/**
 * 高危：命中了就**硬阻断**，必须先清掉才能继续。
 * 只放高置信度的凭据特征，避免误报把人烦到直接跳过扫描。
 */
const BLOCK_CONTENT_RULES = [
	{ id: 'github-token', label: 'GitHub 令牌', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
	{ id: 'openai-key', label: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ id: 'aws-access-key', label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ id: 'private-key', label: '私钥文件内容', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
	{ id: 'slack-token', label: 'Slack 令牌', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
	{ id: 'google-api-key', label: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: 'anthropic-key', label: 'Anthropic 密钥', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
];

/** 高危文件名：这些文件天然装着凭据，一律阻断。 */
const BLOCK_FILENAME_RULES = [
	{ id: 'env-file', label: '环境变量文件', re: /(^|\/)\.env(\.|$)/i },
	{ id: 'pem-key', label: '证书/私钥文件', re: /\.(pem|key|p12|pfx|keystore|jks)$/i },
	{ id: 'ssh-key', label: 'SSH 私钥', re: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i },
	{ id: 'credential-file', label: '凭据文件', re: /(^|\/)(\.npmrc|\.netrc|\.pgpass|credentials|secrets\.(json|ya?ml)|htpasswd)$/i },
];

/**
 * 需要确认：不一定有害，但**绝不允许自动公开**。
 * 命中这些时，一次显式的人工确认是底线。
 */
const CONFIRM_CONTENT_RULES = [
	{ id: 'cn-id-card', label: '疑似身份证号', re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/ },
	{ id: 'cn-phone', label: '疑似手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
	{ id: 'jwt', label: '疑似 JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
	{ id: 'student-id-hint', label: '疑似学号/工号字段', re: /(?:学号|工号|student[_-]?id|student[_-]?no)\s*[:=]\s*["']?\d{6,}/i },
];

/**
 * 绝对路径里的用户名同样会暴露身份 —— 这是开源仓库最常见的无意识泄露。
 * 例如 Windows 用户目录下「盘符 + 反斜杠 + 用户名」开头的路径，
 * 或 Unix 系 home 目录下的绝对路径。
 */
const CONFIRM_PATH_RULES = [
	{ id: 'win-user-path', label: '暴露本机用户名的绝对路径', re: /[A-Za-z]:\\Users\\[^\\\s"'`]+/g },
	{ id: 'nix-user-path', label: '暴露本机用户名的绝对路径', re: /(?:\/home|\/Users)\/[^/\s"'`]+/g },
];

/** 低危：只提示，不拦。 */
const WARN_CONTENT_RULES = [
	{ id: 'password-assign', label: '疑似明文口令赋值', re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
	{ id: 'api-key-assign', label: '疑似明文密钥赋值', re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i },
];

/** 收集一行里所有匹配（用于全局正则，避免 lastIndex 残留）。 */
function matchAll(line, pattern) {
	const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
	const re = new RegExp(pattern.source, flags);
	const hits = [];
	let m;
	while ((m = re.exec(line)) !== null) {
		hits.push(m[0]);
		if (m.index === re.lastIndex) re.lastIndex += 1;
		if (hits.length >= 5) break;
	}
	return hits;
}

/** 二进制判定：前 8 KiB 出现 NUL 字节即视为二进制。 */
function looksBinary(buffer) {
	const limit = Math.min(buffer.length, 8192);
	for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
	return false;
}

/** 载入用户自定义模式（存在才载入；用于补充本机特有的敏感词）。 */
async function loadUserRules() {
	const candidates = [
		process.env.OUTBOX_PATTERNS,
		path.join(os.homedir(), '.outbox', 'patterns.json'),
	].filter((v) => typeof v === 'string' && v.length > 0);

	for (const file of candidates) {
		try {
			const raw = await fs.readFile(file, 'utf8');
			const parsed = JSON.parse(raw);
			const extra = Array.isArray(parsed?.confirm) ? parsed.confirm : [];
			const rules = [];
			for (const item of extra) {
				const source = typeof item === 'string' ? item : item?.pattern;
				if (typeof source !== 'string' || source.length === 0) continue;
				try {
					rules.push({
						id: `user:${item?.id ?? source.slice(0, 24)}`,
						label: item?.label ?? '自定义敏感模式',
						re: new RegExp(source, 'g'),
					});
				} catch {
					/* 非法正则跳过，不因为一条坏规则让整个扫描失败 */
				}
			}
			return rules;
		} catch {
			/* 文件不存在或无权限：静默跳过 */
		}
	}
	return [];
}

/**
 * 把 glob 编译成正则。支持 `**`（跨目录）、`*`（单层内）、`?`（单字符）。
 * 路径统一成 POSIX 分隔符再匹配，保证 Windows / Unix 行为一致。
 */
function globToRegExp(glob) {
	const normalized = String(glob).split('\\').join('/').trim();
	let out = '';
	for (let i = 0; i < normalized.length; i += 1) {
		const ch = normalized[i];
		if (ch === '*') {
			if (normalized[i + 1] === '*') {
				out += '.*';
				i += 1;
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else if ('\\^$.|+()[]{}'.includes(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`, 'i');
}

/**
 * 载入仓库级放行清单 `.outboxallow`。
 *
 * 为什么必须有这个机制：任何**带测试夹具的仓库**都会天然含有假密钥
 * （测试扫描器就得放几个假 token 进去）。没有放行清单，这种仓库会被自己的
 * 闸门拦住 —— outbox 第一次推送时就被自己拦了，这不是 bug，是缺了出口。
 *
 * 格式（每行一条，`#` 开头为注释）：
 *   <路径 glob> [规则 id]
 * 省略规则 id 表示放行该路径下的**全部**规则。
 *
 * 放行清单本身是个普通文件，会一起提交 —— 所以「谁放行了什么」永远可审计，
 * 而不是被静默吞掉。
 */
async function loadAllowList(dir) {
	const file = path.join(dir, '.outboxallow');
	let raw;
	try {
		raw = await fs.readFile(file, 'utf8');
	} catch {
		return [];
	}
	const entries = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const parts = line.split(/\s+/);
		const glob = parts[0];
		if (typeof glob !== 'string' || glob.length === 0) continue;
		entries.push({
			glob,
			rule: parts.length > 1 ? parts[1] : null,
			matcher: globToRegExp(glob),
		});
	}
	return entries;
}

/** 某条命中是否被放行清单豁免。 */
function isAllowed(entries, file, rule) {
	return entries.some((entry) => entry.matcher.test(file) && (entry.rule === null || entry.rule === rule));
}

/**
 * 扫描「即将被提交的文件」。
 *
 * 为什么扫描索引而不是遍历目录：索引里的内容就是**真正会被推上去的东西**，
 * 天然排除了 .gitignore 覆盖的文件，不会对忽略项误报。
 */
export async function scanStaged(dir, env, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
	const maxBytes = options.scanMaxBytes ?? DEFAULTS.scanMaxBytes;

	const listing = await run('git', ['ls-files', '-z', '--cached'], { cwd: dir, env, timeoutMs });
	if (listing.code !== 0) {
		return {
			ok: false,
			error: `无法列出待提交文件：${listing.stderr.trim() || listing.stdout.trim()}`,
			blocked: [], confirm: [], warn: [], scannedFiles: 0,
		};
	}

	const files = listing.stdout.split('\0').filter((f) => f.length > 0);
	const blocked = [];
	const confirm = [];
	const warn = [];
	const userRules = await loadUserRules();

	let scanned = 0;

	for (const rel of files) {
		const abs = path.join(dir, rel);
		const posix = rel.split(path.sep).join('/');

		// 文件名规则
		for (const rule of BLOCK_FILENAME_RULES) {
			if (rule.re.test(posix)) {
				blocked.push({ rule: rule.id, label: rule.label, file: posix, detail: '文件名命中' });
			}
		}

		let stat;
		try {
			stat = await fs.stat(abs);
		} catch {
			continue; // 提前消失的文件（例如构建产物被清掉）不阻断流程
		}
		if (!stat.isFile()) continue;

		// 尺寸规则
		if (stat.size > DEFAULTS.largeFileBlockBytes) {
			blocked.push({
				rule: 'file-too-large',
				label: '文件超过 GitHub 上限',
				file: posix,
				detail: `${(stat.size / 1048576).toFixed(1)} MiB > 95 MiB`,
			});
			continue;
		}
		if (stat.size > DEFAULTS.largeFileWarnBytes) {
			warn.push({
				rule: 'file-large',
				label: '大文件',
				file: posix,
				detail: `${(stat.size / 1048576).toFixed(1)} MiB`,
			});
		}

		if (stat.size > maxBytes) continue;

		let buffer;
		try {
			buffer = await fs.readFile(abs);
		} catch {
			continue;
		}
		if (looksBinary(buffer)) continue;

		scanned += 1;
		const text = buffer.toString('utf8');
		const lines = text.split(/\r?\n/);

		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			if (line.length === 0) continue;
			// 行内放行标记：写在内容同一行，随代码一起被审阅，不存在隐形豁免。
			if (line.includes('outbox:allow')) continue;
			const lineNo = i + 1;

			for (const rule of BLOCK_CONTENT_RULES) {
				if (rule.re.test(line)) {
					blocked.push({ rule: rule.id, label: rule.label, file: posix, line: lineNo, detail: rule.re.source.slice(0, 40) });
				}
			}
			for (const rule of CONFIRM_CONTENT_RULES) {
				if (rule.re.test(line)) {
					confirm.push({ rule: rule.id, label: rule.label, file: posix, line: lineNo });
				}
			}
			for (const rule of userRules) {
				if (rule.re.test(line)) {
					confirm.push({ rule: rule.id, label: rule.label, file: posix, line: lineNo, detail: '自定义模式' });
				}
			}
			for (const rule of WARN_CONTENT_RULES) {
				if (rule.re.test(line)) {
					warn.push({ rule: rule.id, label: rule.label, file: posix, line: lineNo });
				}
			}
			for (const rule of CONFIRM_PATH_RULES) {
				for (const hit of matchAll(line, rule.re)) {
					confirm.push({ rule: rule.id, label: rule.label, file: posix, line: lineNo, detail: hit });
				}
			}
		}
	}

	// 去重：同一文件同一规则同一行只报一次
	const dedupe = (list) => {
		const seen = new Set();
		return list.filter((item) => {
			const key = `${item.rule}|${item.file}|${item.line ?? ''}|${item.detail ?? ''}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};

	// 应用仓库级放行清单：被豁免的命中移入 allowlisted，保持可见而非静默丢弃
	const allowEntries = await loadAllowList(dir);
	const allowlisted = [];
	const applyAllow = (list) =>
		list.filter((item) => {
			if (isAllowed(allowEntries, item.file, item.rule)) {
				allowlisted.push(item);
				return false;
			}
			return true;
		});

	return {
		ok: true,
		scannedFiles: scanned,
		totalFiles: files.length,
		blocked: applyAllow(dedupe(blocked)),
		confirm: applyAllow(dedupe(confirm)),
		warn: applyAllow(dedupe(warn)),
		allowlisted: dedupe(allowlisted),
	};
}

/* ------------------------------------------------------------------ *
 * gh 登录态：检查与自愈
 * ------------------------------------------------------------------ */

/** 从 gh auth status 的输出里抠出账号名（抠不到返回 null）。 */
function parseGhAccount(text) {
	const m = /account\s+([A-Za-z0-9-]+)/i.exec(text ?? '');
	return m ? m[1] : null;
}

/** 从 git credential fill 的输出里抠出 password 字段。 */
function parseCredentialPassword(text) {
	for (const line of String(text ?? '').split(/\r?\n/)) {
		if (line.startsWith('password=')) return line.slice('password='.length);
	}
	return null;
}

/**
 * 确保 gh 处于已登录状态；未登录时从系统凭据管理器自愈。
 *
 * 为什么需要自愈：gh 把登录态存在自己的 hosts.yml 里，这个文件会因版本升级或
 * 配置迁移被清空；但 token 一直躺在系统凭据管理器（Windows 凭据管理器 /
 * macOS Keychain / libsecret）中——所以 git push 从来不用重新登录，gh 却会报未登录。
 * 自愈就是把这个 token 取回来再灌给 gh。
 */
export async function ensureGhAuth(env, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

	const status = await run('gh', ['auth', 'status'], { env, timeoutMs });
	if (status.code === 0) {
		const account = parseGhAccount(`${status.stdout}\n${status.stderr}`);
		return { ok: true, healed: false, account };
	}

	// —— 自愈路径 ——
	const fill = await run('git', ['credential', 'fill'], {
		env,
		timeoutMs,
		input: 'protocol=https\nhost=github.com\n\n',
	});

	const token = parseCredentialPassword(fill.stdout);
	if (token === null || token.length === 0) {
		return {
			ok: false,
			healed: false,
			account: null,
			reason: 'gh 未登录，且无法从系统凭据管理器取到 GitHub 凭据',
			hint: '先在终端执行一次 `gh auth login`，或确认 git 能正常推送到 GitHub。',
			detail: redact(`${fill.stderr}`.trim()),
		};
	}
	rememberSecret(token);

	const login = await run('gh', ['auth', 'login', '--hostname', 'github.com', '--with-token'], {
		env,
		timeoutMs,
		input: `${token}\n`,
	});
	if (login.code !== 0) {
		return {
			ok: false,
			healed: false,
			account: null,
			reason: '取到了凭据，但写入 gh 登录态失败',
			detail: redact(`${login.stderr}\n${login.stdout}`.trim()),
		};
	}

	const recheck = await run('gh', ['auth', 'status'], { env, timeoutMs });
	if (recheck.code !== 0) {
		return {
			ok: false,
			healed: false,
			account: null,
			reason: '自愈后 gh 仍未登录',
			detail: redact(`${recheck.stderr}\n${recheck.stdout}`.trim()),
		};
	}

	return {
		ok: true,
		healed: true,
		account: parseGhAccount(`${recheck.stdout}\n${recheck.stderr}`),
	};
}

/** 取当前 gh 账号名（绝不写死）。 */
export async function getOwner(env, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
	const result = await run('gh', ['api', 'user', '--jq', '.login'], { env, timeoutMs });
	if (result.code !== 0) return null;
	const login = result.stdout.trim();
	return login.length > 0 ? login : null;
}

/* ------------------------------------------------------------------ *
 * 本地仓库准备
 * ------------------------------------------------------------------ */

/** 目录是否在 git 工作树内（含向上查找）。 */
export async function isInsideGitRepo(dir, env, options = {}) {
	const result = await run('git', ['rev-parse', '--is-inside-work-tree'], {
		cwd: dir,
		env,
		timeoutMs: options.timeoutMs ?? 30_000,
	});
	return result.code === 0 && result.stdout.trim() === 'true';
}

/** 取当前分支名（取不到返回 null，例如尚无提交）。 */
export async function currentBranch(dir, env) {
	const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, env, timeoutMs: 30_000 });
	if (result.code !== 0) return null;
	const name = result.stdout.trim();
	return name.length > 0 && name !== 'HEAD' ? name : null;
}

/** 取 origin 的远端地址（没有则 null）。 */
export async function getOriginUrl(dir, env) {
	const result = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, env, timeoutMs: 30_000 });
	if (result.code !== 0) return null;
	const url = result.stdout.trim();
	return url.length > 0 ? url : null;
}

/**
 * 确保目录是一个 git 仓库，并处于目标分支上。
 * 已存在仓库时只做「对齐分支」，不重置任何东西。
 */
export async function ensureLocalRepo(dir, env, options = {}) {
	const branch = options.branch ?? DEFAULTS.branch;
	const steps = [];

	const inside = await isInsideGitRepo(dir, env);
	if (!inside) {
		const init = await run('git', ['init', '-b', branch], { cwd: dir, env });
		if (init.code !== 0) {
			return { ok: false, created: false, reason: 'git init 失败', detail: redact(init.stderr.trim()) };
		}
		steps.push(`git init -b ${branch}`);
	}

	// 关掉中文/特殊字符路径的八进制转义，让输出可读（只影响本仓库）。
	await run('git', ['config', 'core.quotepath', 'false'], { cwd: dir, env });

	// 身份必须能确定，否则提交会失败——失败要说得清楚，别让用户猜。
	const who = await run('git', ['config', 'user.email'], { cwd: dir, env, timeoutMs: 30_000 });
	if (who.code !== 0 || who.stdout.trim().length === 0) {
		return {
			ok: false,
			created: !inside,
			reason: 'git 身份未配置（user.email 为空），无法提交',
			hint: '执行 `git config --global user.name "你的名字"` 与 `git config --global user.email "你的邮箱"`。',
		};
	}

	return { ok: true, created: !inside, branch, steps };
}

/** 把工作区全部变更加入索引（不做任何清理或重置）。 */
export async function stageAll(dir, env) {
	const add = await run('git', ['add', '-A'], { cwd: dir, env });
	if (add.code !== 0) {
		return { ok: false, reason: 'git add 失败', detail: redact(add.stderr.trim()) };
	}
	return { ok: true };
}

/** 统计索引里有多少文件。 */
export async function countStaged(dir, env) {
	const result = await run('git', ['ls-files', '-z', '--cached'], { cwd: dir, env, timeoutMs: 30_000 });
	if (result.code !== 0) return 0;
	return result.stdout.split('\0').filter((f) => f.length > 0).length;
}

/** 是否有内容需要提交。 */
export async function hasChangesToCommit(dir, env) {
	const result = await run('git', ['status', '--porcelain'], { cwd: dir, env, timeoutMs: 30_000 });
	return result.code === 0 && result.stdout.trim().length > 0;
}

/** 提交索引内容；无变更时返回 skipped。 */
export async function commitAll(dir, env, message) {
	if (!(await hasChangesToCommit(dir, env))) {
		return { ok: true, skipped: true, reason: '没有需要提交的变更' };
	}
	const commit = await run('git', ['commit', '-m', message], { cwd: dir, env });
	if (commit.code !== 0) {
		return { ok: false, reason: 'git commit 失败', detail: redact(`${commit.stderr}\n${commit.stdout}`.trim()) };
	}
	const sha = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, env, timeoutMs: 30_000 });
	return { ok: true, skipped: false, sha: sha.stdout.trim(), output: redact(commit.stdout.trim()) };
}

/* ------------------------------------------------------------------ *
 * 远端仓库与推送
 * ------------------------------------------------------------------ */

/** 把目录名规整成合法的 GitHub 仓库名。 */
export function suggestRepoName(dir) {
	const base = path.basename(path.resolve(dir));
	const cleaned = base
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9._-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '');
	return cleaned.length > 0 ? cleaned.slice(0, 100) : 'new-repo';
}

/** 远端仓库是否已存在。 */
export async function remoteRepoExists(owner, name, env) {
	const result = await run('gh', ['repo', 'view', `${owner}/${name}`, '--json', 'name'], { env, timeoutMs: 60_000 });
	return result.code === 0;
}

/** 创建一个远端仓库（不推送，推送由本模块显式控制）。 */
export async function createRemoteRepo(options) {
	const { owner, name, visibility, description, env, timeoutMs = DEFAULTS.timeoutMs } = options;

	const args = ['repo', 'create', `${owner}/${name}`, `--${visibility}`];
	if (typeof description === 'string' && description.trim().length > 0) {
		args.push('--description', description.trim());
	}

	const result = await run('gh', args, { env, timeoutMs });
	if (result.code !== 0) {
		return { ok: false, reason: 'gh repo create 失败', detail: redact(`${result.stderr}\n${result.stdout}`.trim()) };
	}

	const view = await run('gh', ['repo', 'view', `${owner}/${name}`, '--json', 'url,sshUrl,visibility'], {
		env,
		timeoutMs: 60_000,
	});
	let url = null;
	let actualVisibility = visibility;
	if (view.code === 0) {
		try {
			const parsed = JSON.parse(view.stdout);
			url = parsed.url ?? null;
			actualVisibility = (parsed.visibility ?? visibility).toLowerCase();
		} catch {
			/* 解析失败时退回构造值 */
		}
	}
	if (url === null) url = `https://github.com/${owner}/${name}`;

	return { ok: true, url, visibility: actualVisibility, name, owner };
}

/** 关联 origin（已存在则原地更新，避免 push 到错误的远端）。 */
export async function setOrigin(dir, url, env) {
	const existing = await getOriginUrl(dir, env);
	const args = existing === null
		? ['remote', 'add', 'origin', url]
		: ['remote', 'set-url', 'origin', url];
	const result = await run('git', args, { cwd: dir, env });
	if (result.code !== 0) {
		return { ok: false, reason: '设置 origin 失败', detail: redact(result.stderr.trim()) };
	}
	return { ok: true, changed: existing !== url, previous: existing };
}

/** 推送当前分支到 origin。 */
export async function pushBranch(dir, env, options = {}) {
	const branch = options.branch ?? DEFAULTS.branch;
	const proxy = options.proxy;
	const args = [...gitProxyArgs(proxy), 'push', '-u', 'origin', branch];

	const result = await run('git', args, { cwd: dir, env });
	if (result.code !== 0) {
		return {
			ok: false,
			reason: 'git push 失败',
			detail: redact(`${result.stderr}\n${result.stdout}`.trim()),
		};
	}
	return { ok: true, output: redact(`${result.stderr}\n${result.stdout}`.trim()) };
}

/**
 * 回读校验：远端分支 SHA 必须等于本地 HEAD。
 * 这是「推送成功」唯一可信的判据——退出码为 0 也可能是推了旧的东西。
 */
export async function verifyPush(dir, env, options = {}) {
	const branch = options.branch ?? DEFAULTS.branch;
	const proxy = options.proxy;

	const local = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, env, timeoutMs: 30_000 });
	const localSha = local.stdout.trim();

	const remote = await run('git', [...gitProxyArgs(proxy), 'ls-remote', 'origin', `refs/heads/${branch}`], {
		cwd: dir,
		env,
	});
	if (remote.code !== 0) {
		return { verified: false, localSha, remoteSha: null, reason: '无法回读远端分支', detail: redact(remote.stderr.trim()) };
	}
	const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? null;

	return {
		verified: localSha.length > 0 && localSha === remoteSha,
		localSha,
		remoteSha,
		branch,
	};
}

/* ------------------------------------------------------------------ *
 * 编排：一次完整的发布
 * ------------------------------------------------------------------ */

/**
 * 把目录发布到 GitHub。
 *
 * 返回值 status 的语义：
 *   ok              —— 全部完成并通过回读校验
 *   blocked         —— 预检发现高危内容，已停止，什么都没推
 *   needs_decision  —— 需要用户先确认可见性（或发现了敏感信息），还没建远端仓库
 *   dry_run         —— 只做了预检，未提交未推送
 *   error           —— 中途失败
 */
export async function publish(options = {}) {
	const dir = path.resolve(options.dir ?? process.cwd());
	const steps = [];
	const startedAt = Date.now();

	const record = (name, detail) => steps.push({ name, detail, at: Date.now() - startedAt });

	// —— 步骤 0：代理探测 ——
	let proxy;
	if (options.proxyUrl === 'off') {
		proxy = { reachable: false, host: DEFAULTS.proxyHost, port: DEFAULTS.proxyPort, url: null };
	} else if (typeof options.proxyUrl === 'string' && options.proxyUrl.length > 0) {
		const m = /^https?:\/\/([^:/]+):(\d+)/.exec(options.proxyUrl);
		proxy = {
			reachable: true,
			host: m?.[1] ?? DEFAULTS.proxyHost,
			port: m?.[2] ? Number(m[2]) : DEFAULTS.proxyPort,
			url: options.proxyUrl,
		};
	} else {
		proxy = await detectProxy({ port: options.proxyPort ?? DEFAULTS.proxyPort });
	}
	record('proxy', proxy.reachable ? `使用代理 ${proxy.url}` : '未探测到代理，直连');

	const env = buildChildEnv(proxy, process.env, options.envExtra ?? {});

	// —— 步骤 1：gh 登录态（含自愈） ——
	const auth = await ensureGhAuth(env, { timeoutMs: options.timeoutMs });
	record('auth', auth.ok ? (auth.healed ? `gh 未登录，已从系统凭据自愈（${auth.account ?? '未知账号'}）` : `gh 已登录（${auth.account ?? '未知账号'}）`) : `gh 登录不可用：${auth.reason}`);
	if (!auth.ok) {
		return { status: 'error', dir, proxy, auth, steps, error: { step: 'auth', ...auth } };
	}

	// —— 步骤 2：本地仓库 ——
	const repo = await ensureLocalRepo(dir, env, { branch: options.branch ?? DEFAULTS.branch });
	record('local-repo', repo.ok ? (repo.created ? '新建本地仓库' : '已有本地仓库') : `失败：${repo.reason}`);
	if (!repo.ok) {
		return { status: 'error', dir, proxy, auth, steps, error: { step: 'local-repo', ...repo } };
	}

	const stage = await stageAll(dir, env);
	if (!stage.ok) {
		return { status: 'error', dir, proxy, auth, steps, error: { step: 'stage', ...stage } };
	}
	const stagedCount = await countStaged(dir, env);
	record('stage', `索引 ${stagedCount} 个文件`);

	// —— 步骤 3：预检扫描（推送前唯一的安全闸门） ——
	const scan = await scanStaged(dir, env, { timeoutMs: options.timeoutMs });
	record('scan', scan.ok ? `扫描 ${scan.scannedFiles} 个文本文件；阻断 ${scan.blocked.length} / 待确认 ${scan.confirm.length} / 提示 ${scan.warn.length}` : `扫描失败：${scan.error}`);

	if (!scan.ok) {
		return { status: 'error', dir, proxy, auth, steps, scan, error: { step: 'scan', reason: scan.error } };
	}
	if (scan.blocked.length > 0) {
		return {
			status: 'blocked',
			dir, proxy, auth, scan, steps,
			message: '预检发现高危内容，已停止，未创建远端仓库、未提交、未推送。',
		};
	}

	// 敏感信息 → 后续绝不允许自动公开
	const hasSensitive = scan.confirm.length > 0;

	// —— 步骤 4：可见性决策 ——
	const requested = options.visibility ?? 'ask';
	if (requested === 'ask') {
		return {
			status: 'needs_decision',
			dir, proxy, auth, scan, steps,
			proposed: {
				name: options.name ?? suggestRepoName(dir),
				owner: auth.account,
				visibility: 'public',
				reason: '未明确指定可见性',
			},
			message: '请先确认仓库可见性（public / private），再继续。',
		};
	}
	if (requested === 'public' && hasSensitive) {
		return {
			status: 'needs_decision',
			dir, proxy, auth, scan, steps,
			proposed: { name: options.name ?? suggestRepoName(dir), owner: auth.account, visibility: 'private', reason: '命中敏感信息' },
			message: `扫描命中 ${scan.confirm.length} 处敏感信息，公开前必须由你逐条确认。`,
		};
	}

	if (options.dryRun === true) {
		return {
			status: 'dry_run',
			dir, proxy, auth, scan, steps,
			message: '预检通过，dry-run 模式未提交、未推送。',
		};
	}

	// —— 步骤 5：提交 ——
	const message = options.message ?? `chore: initial commit via outbox`;
	const commit = await commitAll(dir, env, message);
	record('commit', commit.ok ? (commit.skipped ? commit.reason : `提交 ${commit.sha?.slice(0, 7)}`) : `失败：${commit.reason}`);
	if (!commit.ok) {
		return { status: 'error', dir, proxy, auth, scan, steps, error: { step: 'commit', ...commit } };
	}

	const branch = options.branch ?? DEFAULTS.branch;

	// —— 步骤 6：远端仓库（已存在就复用，绝不重复建） ——
	const owner = auth.account;
	const name = options.name ?? suggestRepoName(dir);
	let remote = { url: null, created: false, visibility: requested };

	const existingOrigin = await getOriginUrl(dir, env);
	if (existingOrigin !== null) {
		remote.url = existingOrigin;
		record('remote', `沿用已有 origin：${existingOrigin}`);
	} else if (owner === null) {
		return { status: 'error', dir, proxy, auth, scan, steps, error: { step: 'remote', reason: '无法确定 GitHub 账号（gh api user 无返回）' } };
	} else {
		const exists = await remoteRepoExists(owner, name, env);
		if (exists && options.reuseExisting !== false) {
			const url = `https://github.com/${owner}/${name}`;
			await setOrigin(dir, url, env);
			remote = { url, created: false, visibility: requested };
			record('remote', `远端已存在，复用 ${url}`);
		} else {
			const created = await createRemoteRepo({
				owner, name, visibility: requested,
				description: options.description, env, timeoutMs: options.timeoutMs,
			});
			if (!created.ok) {
				return { status: 'error', dir, proxy, auth, scan, steps, error: { step: 'remote', ...created } };
			}
			await setOrigin(dir, created.url, env);
			remote = { url: created.url, created: true, visibility: created.visibility };
			record('remote', `新建 ${created.visibility} 仓库 ${created.url}`);
		}
	}

	// —— 步骤 7：推送 ——
	const push = await pushBranch(dir, env, { branch, proxy });
	record('push', push.ok ? '推送完成' : `失败：${push.reason}`);
	if (!push.ok) {
		return { status: 'error', dir, proxy, auth, scan, steps, remote, commit, error: { step: 'push', ...push } };
	}

	// —— 步骤 8：回读校验 ——
	const verification = await verifyPush(dir, env, { branch, proxy });
	record('verify', verification.verified ? `远端 SHA 与本地一致（${verification.localSha?.slice(0, 7)}）` : `校验不一致：本地 ${verification.localSha?.slice(0, 7)} vs 远端 ${verification.remoteSha?.slice(0, 7)}`);

	return {
		status: verification.verified ? 'ok' : 'error',
		dir, proxy, auth, scan, steps, remote, commit, push: verification,
		repo: { name, owner, url: remote.url, visibility: remote.visibility, created: remote.created },
		branch,
		files: stagedCount,
		error: verification.verified ? undefined : { step: 'verify', ...verification },
	};
}

export const __internal = { redact, rememberSecret, parseGhAccount, parseCredentialPassword, matchAll, looksBinary, suggestRepoName };
