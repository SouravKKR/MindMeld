const path = require('path');
const fs = require('fs');

class Logger
{
    static #enabled = false;
    static #stream = null;
    static #sessionId = null;

    static initialize()
    {
        Logger.#enabled = process.argv.includes('--debug') || process.env.DOCK_DEBUG === '1';
        Logger.#sessionId = Date.now().toString();

        if (!Logger.#enabled) return;

        const logDir = path.join(__dirname, '../../../Agent/logs');
        fs.mkdirSync(logDir, { recursive: true });

        const logFile = path.join(logDir, `session_${Logger.#sessionId}.log`);
        Logger.#stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf-8' });

        Logger.#emit('DOCK', `=== Logging session ${Logger.#sessionId} started ===`);
        Logger.#emit('DOCK', `Log file: ${logFile}`);
    }

    static isEnabled() { return Logger.#enabled; }
    static getSessionId() { return Logger.#sessionId; }

    static #emit(source, message)
    {
        const ts = new Date().toISOString();
        const line = `[${ts}] [${source}] ${message}\n`;
        process.stdout.write(line);
        if (Logger.#stream) Logger.#stream.write(line);
    }

    static log(message, source = 'DOCK')
    {
        if (!Logger.#enabled) return;
        Logger.#emit(source, String(message));
    }

    static logWorker(taskTypeName, taskId, stream, line)
    {
        if (!Logger.#enabled) return;
        if (line === '' || line == null) return;
        const shortId = taskId ? taskId.slice(0, 8) : '????????';
        const tag = `AGENT:${taskTypeName}:${shortId}${stream === 'stderr' ? ':err' : ''}`;
        Logger.#emit(tag, line);
    }
}

module.exports = Logger;
