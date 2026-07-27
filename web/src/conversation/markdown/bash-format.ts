import { useEffect, useState } from 'react';
import { createBashFormatter, createShfmtPrinter } from './bash-format-core';

let formatter: ReturnType<typeof createBashFormatter> | null = null;
let loading: Promise<ReturnType<typeof createBashFormatter>> | null = null;

async function getFormatter(): Promise<ReturnType<typeof createBashFormatter>> {
  if (formatter) return formatter;
  if (!loading) {
    loading = import('mvdan-sh').then((mod) => {
      formatter = createBashFormatter(createShfmtPrinter(mod));
      return formatter;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

export async function formatBash(cmd: string): Promise<string | null> {
  return (await getFormatter()).format(cmd);
}

export function useFormattedBash(cmd: string, enabled: boolean): string | null {
  const [formatted, setFormatted] = useState<string | null>(() => (enabled ? formatter?.peek(cmd) ?? null : null));
  useEffect(() => {
    if (!enabled || cmd === '') {
      setFormatted(null);
      return;
    }
    if (formatter) {
      setFormatted(formatter.format(cmd));
      return;
    }
    let alive = true;
    void formatBash(cmd)
      .then((res) => { if (alive) setFormatted(res); })
      .catch(() => { if (alive) setFormatted(null); });
    return () => { alive = false; };
  }, [cmd, enabled]);
  return formatted;
}
