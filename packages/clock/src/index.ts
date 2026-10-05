import { createId } from '@paralleldrive/cuid2';

export type Clock = {
  now(): string;
};

export type IdGenerator = {
  next(): string;
};

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const systemId: IdGenerator = {
  next: () => createId(),
};

export function fixedClock(instant: string): Clock {
  return { now: () => instant };
}

export function sequentialId(prefix = 'id'): IdGenerator {
  let sequence = 0;
  return {
    next: () => `${prefix}-${++sequence}`,
  };
}

export function fixedIds(values: readonly string[]): IdGenerator {
  let index = 0;
  return {
    next: () => {
      const value = values[index++];
      if (value === undefined) throw new Error('Fixed identity list exhausted');
      return value;
    },
  };
}
