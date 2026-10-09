import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';

/** Возвращает только адрес, уже проверенный и закреплённый транспортом. */
export function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_host, options, callback): void => {
    if (options.all) {
      callback(null, [address]);

      return;
    }

    callback(null, address.address, address.family);
  };
}
