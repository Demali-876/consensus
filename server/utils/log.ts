type LogFields = Record<string, unknown>;

function cleanFields(fields: LogFields = {}): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Buffer.isBuffer(value)) {
      out[key] = `<buffer:${value.length}>`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function line(level: string, scope: string, event: string, fields?: LogFields): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...cleanFields(fields),
  });
}

export const log = {
  info(scope: string, event: string, fields?: LogFields): void {
    console.log(line('info', scope, event, fields));
  },
  warn(scope: string, event: string, fields?: LogFields): void {
    console.warn(line('warn', scope, event, fields));
  },
  error(scope: string, event: string, fields?: LogFields): void {
    console.error(line('error', scope, event, fields));
  },
};

