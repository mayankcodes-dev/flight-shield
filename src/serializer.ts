type SerializerContext = {
  references: WeakMap<object, number>;
  nextReference: number;
};

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function compareSerialized(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createSortKey(value: unknown): string {
  return serialize(value, {
    references: new WeakMap<object, number>(),
    nextReference: 0,
  });
}

function serialize(value: unknown, context: SerializerContext): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return `string:${quote(value)}`;
    case 'boolean':
      return `boolean:${value}`;
    case 'number':
      if (Number.isNaN(value)) {
        return 'number:NaN';
      }
      if (Object.is(value, -0)) {
        return 'number:-0';
      }
      if (value === Infinity) {
        return 'number:Infinity';
      }
      if (value === -Infinity) {
        return 'number:-Infinity';
      }
      return `number:${value}`;
    case 'bigint':
      return `bigint:${value}n`;
    case 'symbol': {
      const globalName = Symbol.keyFor(value);
      return globalName === undefined
        ? `symbol:${String(value)}`
        : `symbol:global:${quote(globalName)}`;
    }
    case 'function':
      return serializeObject(value, context, `function:${quote(value.name)}`);
    case 'object':
      return serializeObject(value, context);
    default:
      return `unknown:${String(value)}`;
  }
}

function serializeObject(
  value: object,
  context: SerializerContext,
  prefix?: string,
): string {
  const existingReference = context.references.get(value);
  if (existingReference !== undefined) {
    return `ref:${existingReference}`;
  }

  const reference = context.nextReference;
  context.nextReference += 1;
  context.references.set(value, reference);

  if (prefix !== undefined) {
    return `${prefix}{${serializeEnumerableProperties(value, context)}}`;
  }

  if (Array.isArray(value)) {
    const values = Array.from({ length: value.length }, (_, index) =>
      Object.prototype.hasOwnProperty.call(value, index)
        ? serialize(value[index], context)
        : 'hole',
    );
    return `array:[${values.join(',')}]`;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time)
      ? 'date:Invalid Date'
      : `date:${quote(value.toISOString())}`;
  }

  if (value instanceof RegExp) {
    return `regexp:${quote(value.source)}/${quote(value.flags)}`;
  }

  if (value instanceof Map) {
    const entries = Array.from(value.entries())
      .map(([key, entryValue]) => ({
        key,
        entryValue,
        sortKey: `${createSortKey(key)}=>${createSortKey(entryValue)}`,
      }))
      .sort((left, right) => compareSerialized(left.sortKey, right.sortKey));

    return `map:{${entries
      .map(({ key, entryValue }) => `${serialize(key, context)}=>${serialize(entryValue, context)}`)
      .join(',')}}`;
  }

  if (value instanceof Set) {
    const values = Array.from(value, (entryValue) => ({
      entryValue,
      sortKey: createSortKey(entryValue),
    })).sort((left, right) => compareSerialized(left.sortKey, right.sortKey));

    return `set:[${values.map(({ entryValue }) => serialize(entryValue, context)).join(',')}]`;
  }

  if (isPlainObject(value)) {
    return `object:{${serializeEnumerableProperties(value, context)}}`;
  }

  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return `${tag.toLowerCase()}:{${serializeEnumerableProperties(value, context)}}`;
}

function serializeEnumerableProperties(value: object, context: SerializerContext): string {
  return Object.keys(value)
    .sort()
    .map((key) => {
      try {
        return `${quote(key)}:${serialize((value as Record<string, unknown>)[key], context)}`;
      } catch {
        return `${quote(key)}:unreadable`;
      }
    })
    .join(',');
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Serializes a value into a deterministic, type-tagged cache key.
 */
export function serializeKey(input: unknown): string {
  return serialize(input, {
    references: new WeakMap<object, number>(),
    nextReference: 0,
  });
}
