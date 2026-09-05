/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Задаётся только если сокет живёт не на том же хосте, что страница. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
