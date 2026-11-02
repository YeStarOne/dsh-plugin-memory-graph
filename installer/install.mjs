#!/usr/bin/env node
/**
 * dsh-plugin-memory-graph installer.
 *
 * 把 memory-graph 引擎与桥接模块部署进已安装的 dsh-onebot-qq，并在
 * bridge.js / index.js 上打六个锚点补丁（ recall 注入、回合捕获、停机冲刷、
 * 配置 schema、deps 透传）。幂等：重复运行只刷新部署文件；卸载可还原。
 *
 * 用法：
 *   node installer/install.mjs            # 安装/刷新
 *   node installer/install.mjs --check    # 只探测，不改任何文件
 *   node installer/install.mjs --uninstall
 *   MG_ONEBOT_DIR=/path/to/dsh-onebot-qq node installer/install.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, copyFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = "from './memory-hub.js'";
const BAK_TAG = 'bak-memgraph';

const args = process.argv.slice(2);
const MODE = args.includes('--uninstall') ? 'uninstall' : args.includes('--check') ? 'check' : 'install';
const FORCE = args.includes('--force');

const log = (m) => console.log(m);
const die = (m) => { console.error('✗ ' + m); process.exit(1); };

function findTargets() {
    const candidates = [];
    const push = (p) => { if (p) candidates.push(p); };
    if (process.env.MG_ONEBOT_DIR) push(resolve(process.env.MG_ONEBOT_DIR));
    // MG_ONLY=1：只处理 MG_ONEBOT_DIR 指定目录，不扫描常规位置（测试/受控环境用）
    if (process.env.MG_ONLY !== '1') {
        const home = homedir();
        const profiles = join(home, '.dsh', 'profiles');
        try {
            for (const name of readdirSync(profiles)) {
                push(join(profiles, name, 'node_modules', 'dsh-onebot-qq'));
            }
        } catch (_) { /* no profiles dir */ }
        push(join(home, 'dsh-plugins', 'dsh-onebot-qq'));
        try {
            push(join(String(execSync('npm root -g', { encoding: 'utf8' }).trim()), 'dsh-onebot-qq'));
        } catch (_) { /* npm not available */ }
    }
    const seen = new Set();
    const targets = [];
    for (const c of candidates) {
        const pkg = join(c, 'package.json');
        if (!existsSync(pkg) || !existsSync(join(c, 'lib', 'bridge.js'))) continue;
        try {
            const meta = JSON.parse(readFileSync(pkg, 'utf8'));
            if (meta.name !== 'dsh-onebot-qq') continue;
            const key = (() => { try { return realpathSync(c); } catch (_) { return c; } })();
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({ dir: c, version: String(meta.version || '0.0.0'), realKey: key, inode: inodeOf(join(c, 'lib', 'bridge.js')) });
        } catch (_) { /* unreadable package.json */ }
    }
    // 同一 inode（硬链接双视图）只补一次
    const byInode = new Map();
    for (const t of targets) {
        const key = t.inode || t.realKey;
        if (byInode.has(key)) byInode.get(key).aliases.push(t.dir);
        else { t.aliases = []; byInode.set(key, t); }
    }
    return [...byInode.values()];
}

function await_import_helper() {
    return null; // 已废弃：execSync 改为顶层导入
}
function inodeOf(file) {
    try { const s = statSync(file); return s.dev + ':' + s.ino; } catch (_) { return null; }
}

/** 供 bin/cli.mjs 调用的入口。 */
export function run() {
    main().catch((e) => die(String(e && e.stack || e)));
}

async function main() {
    if (MODE === 'check') return check();
    if (MODE === 'uninstall') return uninstall();
    return install();
}

function check() {
    const targets = findTargets();
    if (!targets.length) die('未找到 dsh-onebot-qq。可设 MG_ONEBOT_DIR 指向其目录后重试。');
    for (const t of targets) {
        log(`◆ ${t.dir}  (dsh-onebot-qq ${t.version})`);
        if (t.aliases.length) log(`  ↳ 与 ${t.aliases.join(', ')} 为同一份文件（硬链接），只处理这一处`);
        const bridge = readText(join(t.dir, 'lib', 'bridge.js'));
        const index = readText(join(t.dir, 'lib', 'index.js'));
        log(`  已安装: ${bridge.includes(MARKER) ? '是' : '否'}`);
        log(`  锚点: bridge=${countAnchors(bridge, BRIDGE_PATCHES).ok}/${BRIDGE_PATCHES.length} index=${countAnchors(index, INDEX_PATCHES).ok}/${INDEX_PATCHES.length}`);
        const okVersion = /^0\.(9|[1-9][0-9])\./.test(t.version);
        log(`  版本: ${okVersion ? '支持 (0.9.x+)' : '未验证，锚点可能对不上（可用 --force 强行尝试）'}`);
    }
}

async function install() {
    const targets = findTargets();
    if (!targets.length) die('未找到 dsh-onebot-qq。可设 MG_ONEBOT_DIR 指向其目录后重试。');
    for (const t of targets) {
        log(`◆ 安装到 ${t.dir}  (dsh-onebot-qq ${t.version})`);
        if (!/^0\.(9|[1-9][0-9])\./.test(t.version) && !FORCE) {
            die(`  版本 ${t.version} 未经验证；如坚持尝试请加 --force`);
        }
        deployFiles(t.dir);
        applyPatches(t.dir);
        log('  ✓ 完成。下一步：');
        log('    1) 在 dsh-onebot-qq 的配置里加 memory: 块（见 examples/cordis-memory.yml）');
        log('    2) 设置环境变量 MEMORY_GRAPH_CHAT_API_KEY / MEMORY_GRAPH_EMBED_API_KEY');
        log('    3) 先跑 node <onebot>/lib/memory-graph-engine/tools/check_embedding.js 自检向量模型');
        log('    4) 重启 dsh 使补丁生效');
    }
}

function uninstall() {
    const targets = findTargets();
    if (!targets.length) die('未找到 dsh-onebot-qq。');
    for (const t of targets) {
        log(`◆ 从 ${t.dir} 卸载`);
        const bakBridge = join(t.dir, 'lib', `bridge.js.${BAK_TAG}`);
        const bakIndex = join(t.dir, 'lib', `index.js.${BAK_TAG}`);
        if (existsSync(bakBridge)) { copyFileSync(bakBridge, join(t.dir, 'lib', 'bridge.js')); log('  ✓ bridge.js 已还原自备份'); }
        else die('  找不到 bridge.js 备份；请手工移除含 memory-hub 的补丁段。');
        if (existsSync(bakIndex)) { copyFileSync(bakIndex, join(t.dir, 'lib', 'index.js')); log('  ✓ index.js 已还原自备份'); }
        rmSync(join(t.dir, 'lib', 'memory-hub.js'), { force: true });
        rmSync(join(t.dir, 'lib', 'memory-graph-engine'), { recursive: true, force: true });
        log('  ✓ 已移除部署文件。配置里的 memory: 块请自行删除（留着也无害，功能处于关闭态）。');
    }
}

function deployFiles(target) {
    const lib = join(target, 'lib');
    const engineDst = join(lib, 'memory-graph-engine');
    mkdirSync(lib, { recursive: true });
    rmSync(engineDst, { recursive: true, force: true });
    cpSync(join(PKG_ROOT, 'engine'), engineDst, { recursive: true });
    copyFileSync(join(PKG_ROOT, 'lib', 'memory-hub.js'), join(lib, 'memory-hub.js'));
    log('  ✓ 部署 lib/memory-hub.js 与 lib/memory-graph-engine/');
}

// ---------- 补丁定义 ----------

const BRIDGE_PATCHES = [
    {
        name: 'import',
        anchor: "import { InterimTracker } from './interim.js';",
        patch: (text) => text.replace(
            "import { InterimTracker } from './interim.js';",
            "import { createMemoryHub } from './memory-hub.js';\nimport { InterimTracker } from './interim.js';"
        ),
    },
    {
        name: 'constructor',
        anchor: '        this.deps = deps;',
        patch: (text) => text.replace(
            '        this.deps = deps;',
            `        this.deps = deps;
        // memory-hub: long-term memory bridge (undefined unless memory.enabled).
        const memoryConfig = deps.config.memory;
        if (memoryConfig !== undefined && memoryConfig.enabled === true) {
            this.memory = createMemoryHub({
                log: (level, message) => deps.log(level, message),
                config: memoryConfig,
            });
            deps.log('info', 'memory-hub: constructed (enabled=' + this.memory.enabled() + ')');
        } else {
            deps.log('info', 'memory-hub: disabled (no memory config)');
        }`
        ),
    },
    {
        name: 'dispatch-let',
        anchor: '        const final = this.prefixTurn(chatId, text);',
        patch: (text) => text.replace(
            '        const final = this.prefixTurn(chatId, text);',
            '        let final = this.prefixTurn(chatId, text);'
        ),
    },
    {
        name: 'dispatch-recall',
        anchor: '        chat.lastActivityAt = Date.now();',
        patch: (text) => text.replace(
            '        chat.lastActivityAt = Date.now();',
            `        chat.lastActivityAt = Date.now();
        // memory-hub: prepend long-term memory recall before this turn is
        // dispatched (empty string = nothing relevant). Also pair the user
        // message for later extraction. When a 5th dispatch argument carrying
        // {adoptedLifeTurn} exists (fictional scene turns), skip both — scene
        // content must never enter or query the memory graph.
        if (this.memory !== undefined && this.memory.enabled()) {
            const sceneOptions = arguments.length > 4 ? arguments[4] : undefined;
            if (sceneOptions == null || sceneOptions.adoptedLifeTurn == null) {
                try {
                    this.memory.noteTurn(chatId, text);
                    const memoryText = await this.memory.recall(chatId, text);
                    if (memoryText !== '')
                        final = memoryText + '\\n' + final;
                } catch (error) {
                    this.deps.log('warn', 'memory-hub: recall failed ' + String(error));
                }
            }
        }`
        ),
    },
    {
        name: 'turn-start',
        anchor: '            this.deferred.onTurnStart(chatId, session.id);',
        patch: (text) => text.replace(
            '            this.deferred.onTurnStart(chatId, session.id);',
            '            this.deferred.onTurnStart(chatId, session.id);\n            this.memory?.beginTurn(chatId);'
        ),
    },
    {
        name: 'assistant-message',
        anchor: "        if (event.type === 'assistant/message') {",
        patch: (text) => text.replace(
            "        if (event.type === 'assistant/message') {",
            `        if (event.type === 'assistant/message') {
            // memory-hub: capture the full assistant text (pre-bubble-split)
            // before the deferred mute early-return so deferred turns are stored too.
            this.memory?.noteAssistant(chatId, event.data.message);`
        ),
    },
    {
        name: 'turn-end',
        anchor: '            const reason = event.data.reason;',
        patch: (text) => text.replace(
            '            const reason = event.data.reason;',
            `            const reason = event.data.reason;
            // memory-hub: turn settled — pair the full reply with the dispatched
            // user message and buffer for extraction (completed turns only).
            this.memory?.finishTurn(chatId, reason.kind === 'completed');`
        ),
    },
    {
        name: 'stop',
        anchor: '    async stop() {\n        this.stopping = true;',
        patch: (text) => text.replace(
            '    async stop() {\n        this.stopping = true;',
            `    async stop() {
        // memory-hub: flush buffered turns before the bridge stops.
        if (this.memory !== undefined && this.memory.enabled()) {
            try {
                await this.memory.close();
            } catch (error) {
                this.deps.log('warn', 'memory-hub: close failed ' + String(error));
            }
        }
        this.stopping = true;`
        ),
    },
];

const MEMORY_SCHEMA_BLOCK = `    memory: z.object({
        enabled: z.boolean().default(false)
            .description('memory-graph 长期记忆图谱：对话→知识图谱→向量召回，回合前注入相关记忆，回合后后台抽取入库。关闭时零行为差异'),
        chatBaseUrl: z.string().default('')
            .description('抽取用对话模型端点（OpenAI 兼容 /chat/completions）。两个端点都填 offline=无网规则模式（仅验证管线）'),
        chatModel: z.string().default('')
            .description('抽取用对话模型名'),
        chatApiKeyEnv: z.string().default('MEMORY_GRAPH_CHAT_API_KEY')
            .description('对话端点 API Key 的环境变量名（不把 key 写进配置文件）'),
        chatHeaders: z.dict(z.string()).default({})
            .description('对话端点额外 HTTP 头（某些网关要求自定义会话头时使用，如 {"x-session-id": "..."}）'),
        embedBaseUrl: z.string().default('')
            .description('向量端点（OpenAI 兼容 /embeddings）。例：https://api.siliconflow.cn/v1（BAAI/bge-m3 有免费档）'),
        embedModel: z.string().default('BAAI/bge-m3')
            .description('向量模型；换模型前先跑 engine/tools/check_embedding.js 自检（中文塌缩/维度）'),
        embedApiKeyEnv: z.string().default('MEMORY_GRAPH_EMBED_API_KEY')
            .description('向量端点 API Key 的环境变量名'),
        dim: z.number().default(1024)
            .description('向量维度，必须与向量模型真实维度一致（填错检索会静默失效）'),
        kitDir: z.string().default('')
            .description('引擎目录（留空=用安装器部署到 dsh-onebot-qq/lib/memory-graph-engine 的副本）'),
        dataDir: z.string().default('')
            .description('记忆数据根目录，每个 chatId 一个子库（留空=~/.dsh/memory-graph-data）'),
        personaName: z.string().default('助手')
            .description('抽取提示词里的角色名'),
        genderTerm: z.string().default('你')
            .description('抽取提示词里角色对用户的称呼'),
        batchSize: z.number().default(2)
            .description('攒够多少轮对话做一次抽取（越大越省调用、越晚入库）'),
        flushIntervalMs: z.number().default(90000)
            .description('缓冲轮次定时落库间隔（毫秒）'),
    }).description('memory-graph 长期记忆图谱：回合前召回注入 + 回合后后台抽取'),
`;

const INDEX_PATCHES = [
    {
        name: 'config-schema',
        anchor: '    logLevel: z.union(',
        patch: (text) => text.replace(
            /\n(    logLevel: z\.union\()/,
            '\n' + MEMORY_SCHEMA_BLOCK + '$1'
        ),
    },
    {
        name: 'deps-passthrough',
        anchor: '            ...gateConfig,\n            trace: traceSink,',
        patch: (text) => text.replace(
            '            ...gateConfig,\n            trace: traceSink,',
            '            ...gateConfig,\n            // memory-hub: config passthrough (undefined when the section is absent).\n            memory: config.memory,\n            trace: traceSink,'
        ),
    },
];

function countAnchors(text, patches) {
    let ok = 0;
    for (const p of patches) if (text.includes(p.anchor)) ok++;
    return { ok, total: patches.length };
}

function readText(file) { return readFileSync(file, 'utf8'); }

function applyPatches(target) {
    const bridgeFile = join(target, 'lib', 'bridge.js');
    const indexFile = join(target, 'lib', 'index.js');
    let bridge = readText(bridgeFile);

    if (bridge.includes(MARKER)) {
        log('  = bridge.js 已含 memory-hub 挂钩，跳过补丁（部署文件已刷新）');
        verifyIndexConfig(target);
        return;
    }

    // 备份（只在首次安装时做，避免二次备份覆盖原始备份）
    const bakBridge = join(target, 'lib', `bridge.js.${BAK_TAG}`);
    const bakIndex = join(target, 'lib', `index.js.${BAK_TAG}`);
    if (!existsSync(bakBridge)) copyFileSync(bridgeFile, bakBridge);

    for (const p of BRIDGE_PATCHES) {
        const before = bridge;
        bridge = p.patch(bridge);
        if (bridge === before) die(`  bridge.js 补丁 ${p.name} 锚点未命中，已中止（原文件未改动）。版本不兼容时请提 issue 并附 dsh-onebot-qq 版本号。`);
    }
    writeFileSync(bridgeFile, bridge, 'utf8');
    log('  ✓ bridge.js 已打 7 处挂钩（备份: ' + basename(bakBridge) + '）');

    verifyIndexConfig(target);
}

function verifyIndexConfig(target) {
    const indexFile = join(target, 'lib', 'index.js');
    let index = readText(indexFile);
    if (index.includes('memory: config.memory,')) {
        log('  = index.js 已含 memory 配置段，跳过');
        return;
    }
    const bakIndex = join(target, 'lib', `index.js.${BAK_TAG}`);
    if (!existsSync(bakIndex)) copyFileSync(indexFile, bakIndex);
    for (const p of INDEX_PATCHES) {
        const before = index;
        index = p.patch(index);
        if (index === before) die(`  index.js 补丁 ${p.name} 锚点未命中，已中止（原文件未改动）。`);
    }
    writeFileSync(indexFile, index, 'utf8');
    log('  ✓ index.js 已加 memory 配置 schema 与 deps 透传（备份: ' + basename(bakIndex) + '）');
}

// 直接执行（node installer/install.mjs）时自动运行；被 import 时不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run();
}
