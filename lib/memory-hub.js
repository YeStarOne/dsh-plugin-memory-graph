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

    return {
        /** True when the hub is configured and the engine is loadable. */
        enabled() {
            return cfg.enabled === true && loadKit() !== null;
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
