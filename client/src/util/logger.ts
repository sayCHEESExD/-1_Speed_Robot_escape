type Level = 'info' | 'warn' | 'error';

const emit = (level: Level, scope: string, args: unknown[]): void => {
  const prefix = `[${scope}]`;
  if (level === 'warn') console.warn(prefix, ...args);
  else if (level === 'error') console.error(prefix, ...args);
  else console.log(prefix, ...args);
};

/** Tiny scoped logger so console output stays greppable during verification. */
export const logger = {
  info: (scope: string, ...args: unknown[]): void => emit('info', scope, args),
  warn: (scope: string, ...args: unknown[]): void => emit('warn', scope, args),
  error: (scope: string, ...args: unknown[]): void => emit('error', scope, args),
};
