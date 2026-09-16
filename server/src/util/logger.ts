/** Minimal scoped logger. One format, so grepping a log is predictable. */
const stamp = (): string => new Date().toISOString().slice(11, 23);

const write = (
  level: 'INFO' | 'WARN' | 'ERROR',
  scope: string,
  args: unknown[],
): void => {
  const line = `${stamp()} ${level.padEnd(5)} [${scope}]`;
  if (level === 'ERROR') console.error(line, ...args);
  else if (level === 'WARN') console.warn(line, ...args);
  else console.log(line, ...args);
};

export const logger = {
  info: (scope: string, ...args: unknown[]): void => write('INFO', scope, args),
  warn: (scope: string, ...args: unknown[]): void => write('WARN', scope, args),
  error: (scope: string, ...args: unknown[]): void => write('ERROR', scope, args),
};
