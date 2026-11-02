/**
 * Long-term memory bridge for the QQ channel (memory-graph integration).
 *
 * Wires the memory-graph engine into the OneBot bridge at two points only:
 *   - recall:  before a turn is dispatched, prepend the retrieved memory block
 *   - capture: turn/start + assistant/message + turn/end accumulate the full
 *     user/reply pair and buffer it for background extraction
 *
 * Design constraints:
 *   - the engine is loaded lazily (CommonJS require from this ESM module) and
 *     every failure degrades to "no memory" — it must never break a reply;
 *   - extraction is fire-and-forget (it costs 2-4 LLM calls per batch);
 *   - one data directory per chat id, so different chats never share a store;
 *   - everything is off unless `memory.enabled` is true in the plugin config.
 *
 * @module dsh-onebot-qq/memory-hub
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir as home } from 'node:os';

const require = createRequire(import.meta.url);

/** Default engine location: the copy the installer deploys next to this file. */
const BUNDLED_KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'memory-graph-engine');
const DEFAULT_KIT_DIR = join(home(), 'memory-graph-engine');
const DEFAULT_DATA_DIR = join(home(), '.dsh', 'memory-graph-data');

/** "private:12345" -> "private_12345"; keeps the store layout readable. */
function dirKey(chatId) {
    return String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
}

const TYPE_CN = { event: '事件', entity: '实体', concept: '概念', summary: '摘要' };

/**
 * 管理指令语法（仅当 memory.enabled 时才做匹配；未命中一律放行正常回合）。
 * 分隔符要求标点或空白——「记住这个教训」这类普通句子不会被拦截。
 */
const CMD_PIN = /^(?:帮我记住|幫我記住|记住|記住|不许忘|不許忘|钉住|釘住|remember|pin)\s*[：:，,。.！!？?\s]\s*(.+)$/i;
const CMD_FORGET = /^(?:帮我忘掉|幫我忘掉|忘掉|忘記|忘记|删掉|刪掉|forget)\s*[：:，,。.！!？?\s]\s*(.+)$/i;
const CMD_LIST = /^(?:我的记忆|记忆列表|你记得什么|你記得什麼|看看记忆|memory list)\s*[?？!！。.]?\s*$/i;
const CMD_STATS = /^(?:记忆统计|记忆状态|memory stats)\s*[?？]?\s*$/i;
const CMD_SUMMARIZE = /^(?:整理记忆|归纳记忆|整理一下记忆|summarize)\s*[?？!！。.]?\s*$/i;

export function createMemoryHub(deps) {
    const cfg = deps.config ?? {};
    const kitDir = cfg.kitDir || (existsSync(BUNDLED_KIT_DIR) ? BUNDLED_KIT_DIR : DEFAULT_KIT_DIR);
    const dataRoot = cfg.dataDir || DEFAULT_DATA_DIR;
    const engines = new Map();
    /** chatId -> in-flight open promise (see engineFor). */
    const openings = new Map();
    /** chatId -> the user message of the turn currently being generated. */
    const pendingTurns = new Map();
    /** chatId -> accumulated assistant text of the running turn (captured
     * pre-bubble-split at the session-event layer). */
    const turnReplies = new Map();
    /** chatId -> assistant message ids already consumed this turn (the
     * session re-emits messages on streaming/usage updates). */
    const seenMessageIds = new Map();
    let kit = null;
    let loadError = null;
    /** Periodic flush: bounded staleness for buffered turns. */
    let flushTimer = null;
    /** Daily maintenance: decay + prune + compaction + theme summarization. */
    let maintainTimer = null;
    let warnedNotReady = false;

    const warnOnce = (message) => {
        if (warnedNotReady) return;
        warnedNotReady = true;
        deps.log('warn', message);
    };

    /** Lazy require, kept out of the module top level so a broken or missing
     * engine never prevents the plugin from loading. */
    const loadKit = () => {
        if (kit !== null || loadError !== null) return kit;
        try {
            kit = require(join(kitDir, 'src', 'index.js'));
            deps.log('info', 'memory-hub: engine loaded from ' + kitDir);
        } catch (error) {
            loadError = error;
            deps.log('warn', 'memory-hub: engine load failed (' + kitDir + '): ' + String(error));
        }
        return kit;
    };

    const endpointsConfigured = () =>
        (String(cfg.chatBaseUrl || '') !== '' && String(cfg.embedBaseUrl || '') !== '')
        || (String(cfg.chatBaseUrl || '') === 'offline' && String(cfg.embedBaseUrl || '') === 'offline');

    /** Two OpenAI-shaped endpoints: one for extraction chat, one for
     * embeddings. `offline` on BOTH switches to the engine's offline provider
     * (rule-based extraction + n-gram vectors) — useful for dry-runs. */
    const provider = () => {
        const k = loadKit();
        if (k === null) return null;
        const { providers } = k;
        const chatBase = String(cfg.chatBaseUrl || '');
        const embedBase = String(cfg.embedBaseUrl || '');
        if (chatBase === 'offline' && embedBase === 'offline') {
            return providers.offline({ dim: cfg.dim || 1024 });
        }
        const headers = (cfg.chatHeaders && typeof cfg.chatHeaders === 'object')
            ? { ...cfg.chatHeaders }
            : {};
        const chat = providers.openai({
            baseUrl: chatBase,
            apiKey: process.env[cfg.chatApiKeyEnv || 'MEMORY_GRAPH_CHAT_API_KEY'] || '',
            chatModel: cfg.chatModel || '',
            headers,
        });
        const embed = providers.openai({
            baseUrl: embedBase,
            apiKey: process.env[cfg.embedApiKeyEnv || 'MEMORY_GRAPH_EMBED_API_KEY'] || '',
            embedModel: cfg.embedModel || 'BAAI/bge-m3',
            dim: cfg.dim || 1024,
        });
        return {
            name: 'combo',
            dim: cfg.dim || 1024,
            chat: (...a) => chat.chat(...a),
            embed: (...a) => embed.embed(...a),
        };
    };

    /** One engine per chat, opened on first use. Concurrent callers await the
     * same in-flight open — two simultaneous enqueues must not each build an
     * engine over the same directory (the second instance would swallow the
     * first one's buffered turn). */
    const engineFor = (chatId) => {
        const existing = engines.get(chatId);
        if (existing !== undefined) return Promise.resolve(existing);
        const opening = openings.get(chatId);
        if (opening !== undefined) return opening;
        const k = loadKit();
        if (k === null) return Promise.resolve(null);
        if (!endpointsConfigured()) {
            warnOnce('memory-hub: memory.enabled is true but chatBaseUrl/embedBaseUrl are not configured (or both must be "offline") — staying inactive');
            return Promise.resolve(null);
        }
        const dir = join(dataRoot, dirKey(chatId));
        const p = Promise.resolve()
            .then(() => k.MemoryEngine.open({
                dir,
                provider: provider(),
                persona: {
                    personaName: cfg.personaName || '助手',
                    genderTerm: cfg.genderTerm || '你',
                },
                batchSize: cfg.batchSize || 2,
            }))
            .then((engine) => {
                engines.set(chatId, engine);
                deps.log('info', 'memory-hub: engine opened ' + chatId + ' -> ' + dir);
                if (flushTimer === null) {
                    flushTimer = setInterval(() => {
                        for (const [, eng] of engines) {
                            eng.flush().catch((error) => {
                                deps.log('warn', 'memory-hub: flush failed: ' + String(error));
                            });
                        }
                    }, cfg.flushIntervalMs || 90_000);
                    flushTimer.unref?.();
                }
                if (maintainTimer === null) {
                    maintainTimer = setInterval(() => {
                        for (const [, eng] of engines) {
                            try {
                                eng.maintain();
                            } catch (error) {
                                deps.log('warn', 'memory-hub: maintain failed: ' + String(error));
                            }
                            Promise.resolve()
                                .then(() => eng.summarize({ maxTopics: 5 }))
                                .catch((error) => {
                                    deps.log('warn', 'memory-hub: summarize failed: ' + String(error));
                                });
                        }
                    }, cfg.maintainIntervalMs || 86_400_000);
                    maintainTimer.unref?.();
                }
                return engine;
            })
            .catch((error) => {
                deps.log('warn', 'memory-hub: engine open failed for ' + chatId + ': ' + String(error));
                return null;
            })
            .finally(() => {
                openings.delete(chatId);
            });
        openings.set(chatId, p);
        return p;
    };

    // ---- QQ 管理指令（命中即直接回复，回合不派发；全部吞异常降级） ----

    async function cmdPin(chatId, content) {
        if (content.length < 2 || content.length > 200) return null; // 太长当普通话，走正常抽取
        const engine = await engineFor(chatId);
        if (engine === null) return null;
        try {
            const r = await engine.addCustomEvent(content);
            if (!r) return '这条记不下来（内容长度需在 2~500 字之间）';
            return r.deduped
                ? '📌 这条本来就在，已重新钉牢：' + truncate(content, 60)
                : '📌 已钉住（永不遗忘）：' + truncate(content, 60);
        } catch (error) {
            deps.log('warn', 'memory-hub: pin failed ' + String(error));
            return '记忆指令执行失败，稍后再试吧';
        }
    }

    async function cmdForget(chatId, query) {
        if (query.length > 100) return null;
        const engine = await engineFor(chatId);
        if (engine === null) return null;
        try {
            const removed = engine.forgetByText(query);
            if (!removed.length) return '没有找到匹配的记忆（可用「我的记忆」看看都记了些什么）';
            return '🗑 已忘掉 ' + removed.length + ' 条记忆：\n'
                + removed.slice(0, 5).map((x) => '· ' + truncate(x.content, 40)).join('\n')
                + (removed.length > 5 ? '\n…共 ' + removed.length + ' 条' : '');
        } catch (error) {
            deps.log('warn', 'memory-hub: forget failed ' + String(error));
            return '记忆指令执行失败，稍后再试吧';
        }
    }

    async function cmdList(chatId) {
        const engine = await engineFor(chatId);
        if (engine === null) return null;
        try {
            const s = engine.stats();
            const total = s.totalNodes || 0;
            if (total === 0) return '📚 记忆库还是空的——聊聊天就会长出来';
            const list = engine.listNodes({ limit: 10 });
            return '📚 记忆库共 ' + total + ' 条（事件 ' + (s.event || 0) + ' / 实体 ' + (s.entity || 0)
                + ' / 概念 ' + (s.concept || 0) + ' / 摘要 ' + (s.summary || 0) + '）\n'
                + list.nodes.map((n, i) => (i + 1) + '. [' + (TYPE_CN[n.nodeType] || n.nodeType) + '] ' + truncate(n.content, 40)).join('\n')
                + (total > 10 ? '\n…（只显示最近 10 条）' : '');
        } catch (error) {
            deps.log('warn', 'memory-hub: list failed ' + String(error));
            return '记忆指令执行失败，稍后再试吧';
        }
    }

    async function cmdStats(chatId) {
        const engine = await engineFor(chatId);
        if (engine === null) return null;
        try {
            const s = engine.stats();
            return '📊 记忆统计：节点 ' + (s.totalNodes || 0)
                + '（事件 ' + (s.event || 0) + ' / 实体 ' + (s.entity || 0) + ' / 概念 ' + (s.concept || 0) + ' / 摘要 ' + (s.summary || 0)
                + '）、关系边 ' + (s.totalEdges || 0)
                + '、库大小 ' + ((s.dbSizeBytes || 0) / 1024).toFixed(1) + ' KB'
                + (s.pending ? '、待入库 ' + s.pending + ' 轮' : '');
        } catch (error) {
            deps.log('warn', 'memory-hub: stats failed ' + String(error));
            return '记忆指令执行失败，稍后再试吧';
        }
    }

    async function cmdSummarize(chatId) {
        const engine = await engineFor(chatId);
        if (engine === null) return null;
        try {
            const topics = await engine.summarize({ maxTopics: 5 });
            if (!topics.length) return '🔁 暂时没有能形成主题的记忆（同一主题下至少 3 条事件；聊得越多整理得越好）';
            return '✨ 整理完成，' + topics.length + ' 个长期主题：\n'
                + topics.map((t) => '· [' + t.topic + '] ' + truncate(t.content, 56)).join('\n');
        } catch (error) {
            deps.log('warn', 'memory-hub: summarize failed ' + String(error));
            return '记忆整理失败（' + truncate(String((error && error.message) || error), 60) + '）';
        }
    }

    return {
        /** True when the hub is configured and the engine is loadable. */
        enabled() {
            return cfg.enabled === true && loadKit() !== null;
        },
        /**
         * In-chat management commands ("记住：…" / "忘掉 …" / "我的记忆" /
         * "记忆统计" / "整理记忆"). Returns the reply text when the input IS a
         * command — the bridge answers directly and does NOT dispatch a model
         * turn — or null when it is a normal message. Never throws.
         */
        async handleCommand(chatId, rawText) {
            if (cfg.enabled !== true) return null;
            const text = String(rawText || '').trim();
            if (!text || text.length > 220) return null;
            try {
                let m;
                if ((m = CMD_PIN.exec(text))) return await cmdPin(chatId, m[1].trim());
                if ((m = CMD_FORGET.exec(text))) return await cmdForget(chatId, m[1].trim());
                if (CMD_LIST.test(text)) return await cmdList(chatId);
                if (CMD_STATS.test(text)) return await cmdStats(chatId);
                if (CMD_SUMMARIZE.test(text)) return await cmdSummarize(chatId);
            } catch (error) {
                deps.log('warn', 'memory-hub: handleCommand failed ' + String(error));
                return '记忆指令执行失败，稍后再试吧';
            }
            return null;
        },
        /**
         * Retrieve the prompt block for one incoming message. Empty string when
         * nothing relevant was found or anything went wrong — callers prepend it
         * unconditionally, matching the engine's own contract.
         */
        async recall(chatId, query) {
            if (cfg.enabled !== true) return '';
            try {
                const engine = await engineFor(chatId);
                if (engine === null) return '';
                const r = await engine.recall(query);
                const text = (r && typeof r.promptText === 'string') ? r.promptText : '';
                if (text !== '')
                    deps.log('debug', 'memory-hub: recalled for ' + chatId + ' (' + text.length + ' chars)');
                return text;
            } catch (error) {
                deps.log('warn', 'memory-hub: recall failed for ' + chatId + ': ' + String(error));
                return '';
            }
        },
        /** Remember the user side of the turn being generated (paired with the
         * reply later, when the turn settles). */
        noteTurn(chatId, userMessage) {
            pendingTurns.set(String(chatId), String(userMessage ?? ''));
        },
        /** Buffer one delivered turn directly. Fire-and-forget; never awaited. */
        enqueue(chatId, aiResponse) {
            if (cfg.enabled !== true) return;
            const key = String(chatId);
            const userMessage = pendingTurns.get(key) ?? '';
            pendingTurns.delete(key);
            if (userMessage === '') return;
            void (async () => {
                try {
                    const engine = await engineFor(key);
                    if (engine === null) return;
                    engine.enqueue({ userMessage, aiResponse });
                } catch (error) {
                    deps.log('warn', 'memory-hub: enqueue failed for ' + key + ': ' + String(error));
                }
            })();
        },
        /** Fresh accumulator for a starting turn. */
        beginTurn(chatId) {
            if (cfg.enabled !== true) return;
            const key = String(chatId);
            turnReplies.delete(key);
            seenMessageIds.delete(key);
        },
        /** Capture one assistant message's text (deduped by message id).
         * This is the full reply at the point where the session produced it —
         * upstream of every bubble/TTS split downstream. */
        noteAssistant(chatId, message) {
            if (cfg.enabled !== true) return;
            const key = String(chatId);
            const id = message && message.id;
            if (id !== undefined && id !== null) {
                let seen = seenMessageIds.get(key);
                if (seen === undefined) { seen = new Set(); seenMessageIds.set(key, seen); }
                if (seen.has(id)) return;
                seen.add(id);
            }
            const blocks = Array.isArray(message && message.content) ? message.content : [];
            const text = blocks
                .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('');
            if (text === '') return;
            const prior = turnReplies.get(key);
            turnReplies.set(key, prior === undefined ? text : prior + '\n' + text);
        },
        /** Turn settled: pair the accumulated reply with the dispatched user
         * message and buffer for extraction. Completed turns only — errored
         * or cancelled turns drop both sides so nothing stale pairs later. */
        finishTurn(chatId, ok) {
            const key = String(chatId);
            const reply = turnReplies.get(key) ?? '';
            turnReplies.delete(key);
            seenMessageIds.delete(key);
            const userMessage = pendingTurns.get(key) ?? '';
            pendingTurns.delete(key);
            if (cfg.enabled !== true || ok !== true || reply === '' || userMessage === '') return;
            void (async () => {
                try {
                    const engine = await engineFor(key);
                    if (engine === null) return;
                    engine.enqueue({ userMessage, aiResponse: reply });
                    deps.log('info', 'memory-hub: turn buffered ' + key + ' (' + reply.length + ' chars)');
                } catch (error) {
                    deps.log('warn', 'memory-hub: enqueue failed for ' + key + ': ' + String(error));
                }
            })();
        },
        /** Daily maintenance (decay + prune + compaction). */
        async maintain() {
            if (cfg.enabled !== true) return;
            for (const [chatId, engine] of engines) {
                try {
                    engine.maintain();
                } catch (error) {
                    deps.log('warn', 'memory-hub: maintain failed for ' + chatId + ': ' + String(error));
                }
            }
        },
        /** Flush buffers and release; await on shutdown or the last turns are lost. */
        async close() {
            if (flushTimer !== null) {
                clearInterval(flushTimer);
                flushTimer = null;
            }
            if (maintainTimer !== null) {
                clearInterval(maintainTimer);
                maintainTimer = null;
            }
            for (const [chatId, engine] of engines) {
                try {
                    await engine.close();
                    deps.log('info', 'memory-hub: closed ' + chatId);
                } catch (error) {
                    deps.log('warn', 'memory-hub: close failed for ' + chatId + ': ' + String(error));
                }
            }
            engines.clear();
            pendingTurns.clear();
        },
        async stats() {
            const out = {};
            for (const [chatId, engine] of engines) {
                try {
                    out[chatId] = engine.stats();
                } catch (error) {
                    out[chatId] = { error: String(error) };
                }
            }
            return out;
        },
    };
}
