import { useCallback, useState } from "react";

export default function useScopedStatus(scope) {
  const [entry, setEntry] = useState(null);
  const key = scope || "";
  const status = entry && entry.scope === key ? entry.value : null;
  const setStatus = useCallback((value) => setEntry(value ? { scope: key, value } : null), [key]);
  return [status, setStatus];
}
