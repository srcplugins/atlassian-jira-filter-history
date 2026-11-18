// In-memory substitute for the @forge/kvs calls the app makes: key order, prefix queries, pages,
// cursors, transactions, batch deletes, a set that returns the value it replaced and one that
// refuses an existing key. `failing` makes every call throw, as an outage does;
// `failNext(call, key)` makes the next such call (on a key starting with `key`) fail once.
export function memoryKvs({ failing = false } = {}) {
  const data = new Map();
  const calls = [];
  const planned = [];
  const guard = (name, keys = []) => {
    calls.push(name);
    if (failing) throw Error('private storage failure');
    const index = planned.findIndex(
      (plan) => plan.name === name && keys.some((key) => key.startsWith(plan.key)),
    );
    if (index >= 0) {
      planned.splice(index, 1);
      throw Error('private storage failure');
    }
  };
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const kvs = {
    async get(key) {
      guard('get', [key]);
      return clone(data.get(key));
    },
    async set(key, value, options) {
      guard('set', [key]);
      // KVS refuses a FAIL_IF_EXISTS write to a key that has a value; expiry (`ttl`) isn't modelled.
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) throw Error('key exists');
      const previous = clone(data.get(key));
      data.set(key, clone(value));
      if (options?.returnValue === 'PREVIOUS' && previous !== undefined)
        return { key, value: previous };
    },
    async delete(key) {
      guard('delete', [key]);
      data.delete(key);
    },
    async batchDelete(items) {
      guard('batchDelete');
      if (items.length > 25) throw Error('batch too large');
      // A planned `batchDelete` failure reports the matching keys as failed, as KVS does.
      const failed = items.filter(({ key }) => {
        const index = planned.findIndex(
          (plan) => plan.name === 'batchDelete' && key.startsWith(plan.key),
        );
        if (index < 0) return false;
        planned.splice(index, 1);
        return true;
      });
      for (const item of items) if (!failed.includes(item)) data.delete(item.key);
      return {
        successfulKeys: items.filter((item) => !failed.includes(item)),
        failedKeys: failed.map(({ key }) => ({ key, error: { code: 'ERROR' } })),
      };
    },
    transact() {
      const writes = [];
      const builder = {
        set(key, value) {
          writes.push([key, clone(value)]);
          return builder;
        },
        delete(key) {
          writes.push([key, undefined]);
          return builder;
        },
        async execute() {
          guard(
            'transact',
            writes.map(([key]) => key),
          );
          for (const [key, value] of writes)
            if (value === undefined) data.delete(key);
            else data.set(key, value);
        },
      };
      return builder;
    },
    query() {
      let prefix = '';
      let limit = 10;
      let after;
      const builder = {
        where(property, condition) {
          if (property !== 'key' || condition.condition !== 'BEGINS_WITH') throw Error('bad where');
          prefix = condition.values[0];
          return builder;
        },
        limit(value) {
          if (value < 1 || value > 100) throw Error('bad limit');
          limit = value;
          return builder;
        },
        cursor(value) {
          after = value;
          return builder;
        },
        async getMany() {
          guard('query', [prefix]);
          const keys = [...data.keys()]
            .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
            .sort();
          const page = keys.slice(0, limit);
          return {
            results: page.map((key) => ({ key, value: clone(data.get(key)) })),
            ...(keys.length > limit ? { nextCursor: page.at(-1) } : {}),
          };
        },
      };
      return builder;
    },
  };
  const WhereConditions = {
    beginsWith: (value) => ({ condition: 'BEGINS_WITH', values: [value] }),
  };
  const failNext = (name, key = '') => planned.push({ name, key });
  return { kvs, WhereConditions, data, calls, failNext };
}
