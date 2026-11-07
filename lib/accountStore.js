'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_STORE_BYTES = 4 * 1024 * 1024;

// The UI and Homebridge run in separate processes. Keep each update atomic and
// merge it with the latest file while holding a short, per-account lock.
class AccountStore {
    constructor(directory, email) {
        this.directory = path.resolve(directory);
        this.file = path.join(this.directory,
            crypto.createHash('sha256').update(email).digest('hex') + '.json');
        this.lock = this.file + '.lock';
    }

    async ensureDirectory() {
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stat = await fs.promises.lstat(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid account directory');
        await fs.promises.chmod(this.directory, 0o700);
    }

    async read() {
        await this.ensureDirectory();
        let handle;
        try {
            handle = await fs.promises.open(this.file,
                fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error('Invalid account file');
            await handle.chmod(0o600);
            const text = await handle.readFile('utf8');
            let record;
            try { record = JSON.parse(text); } catch (_) { return {}; }
            return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
        } finally {
            if (handle) await handle.close();
        }
    }

    async update(change) {
        await this.ensureDirectory();
        let lockHandle;
        const deadline = Date.now() + 3000;
        while (!lockHandle) {
            try {
                lockHandle = await fs.promises.open(this.lock, 'wx', 0o600);
            } catch (error) {
                if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
                try {
                    const stat = await fs.promises.lstat(this.lock);
                    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid account lock');
                    if (Date.now() - stat.mtimeMs > 30000) {
                        await fs.promises.unlink(this.lock);
                        continue;
                    }
                } catch (lockError) {
                    if (lockError.code !== 'ENOENT') throw lockError;
                }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        let temporaryHandle;
        try {
            const next = await change(await this.read());
            const serialized = JSON.stringify(next);
            if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('Account file is too large');
            temporaryHandle = await fs.promises.open(temporary, 'wx', 0o600);
            await temporaryHandle.writeFile(serialized, 'utf8');
            await temporaryHandle.sync();
            await temporaryHandle.close();
            temporaryHandle = undefined;
            await fs.promises.rename(temporary, this.file);
            return next;
        } finally {
            if (temporaryHandle) await temporaryHandle.close();
            await fs.promises.unlink(temporary).catch(() => {});
            await lockHandle.close();
            await fs.promises.unlink(this.lock).catch(() => {});
        }
    }
}

module.exports = { AccountStore };
