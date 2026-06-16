import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { getApiKey, setApiKey, UNAUTHORIZED_EVENT } from "../lib/api";

interface ApiKeyState {
  apiKey: string | null;
  unauthorized: boolean;
  saveKey: (key: string) => void;
}

const ApiKeyContext = createContext<ApiKeyState | null>(null);

/**
 * Holds the API key (persisted in localStorage as mc_api_key) and flips
 * `unauthorized` when any fetch comes back 401 — the Layout then shows the
 * key-entry banner. Demo mode never 401s, so the banner stays hidden there.
 */
export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyState] = useState<string | null>(() => getApiKey());
  const [unauthorized, setUnauthorized] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const saveKey = useCallback(
    (key: string) => {
      setApiKey(key);
      setApiKeyState(getApiKey());
      setUnauthorized(false);
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  return (
    <ApiKeyContext.Provider value={{ apiKey, unauthorized, saveKey }}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey(): ApiKeyState {
  const value = useContext(ApiKeyContext);
  if (!value) throw new Error("useApiKey must be used inside ApiKeyProvider");
  return value;
}
