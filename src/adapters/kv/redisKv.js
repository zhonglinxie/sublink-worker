export class RedisKVAdapter {
    constructor(options = {}) {
        const { prefix, client, manageConnection = false } = options;
        if (!client) {
            throw new Error('Redis KV adapter requires an active Redis client instance');
        }
        this.prefix = prefix ? `${prefix}:` : '';
        this.client = client;
        this.manageConnection = manageConnection;
    }

    formatKey(key) {
        return `${this.prefix}${key}`;
    }

    async get(key) {
        const value = await this.client.get(this.formatKey(key));
        return value ?? null;
    }

    async put(key, value, options = {}) {
        const ttlSeconds = normalizeTtl(options.expirationTtl);
        const formattedKey = this.formatKey(key);
        if (typeof ttlSeconds === 'number') {
            await this.client.set(formattedKey, value, 'EX', ttlSeconds);
        } else {
            await this.client.set(formattedKey, value);
        }
    }

    async compareAndSet(key, expected, value) {
        return await this.client.eval("if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2]) return 1", 1, this.formatKey(key), expected ?? '', value) === 1;
    }

    async delete(key) {
        await this.client.del(this.formatKey(key));
    }

    async disconnect() {
        if (this.manageConnection && this.client) {
            await this.client.quit();
        }
    }
}

function normalizeTtl(ttl) {
    if (!ttl && ttl !== 0) return null;
    const parsed = Math.floor(Number(ttl));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
