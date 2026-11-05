export type { ConsolidationAction, MemoryConsolidateDeps } from "./consolidate.js";
export {
  CONSOLIDATE_BATCH_FACTS,
  CONSOLIDATE_MIN_NEW_FACTS,
  consolidateObserverMemories,
  observersDueForConsolidation,
} from "./consolidate.js";
export type { MemoryDreamDeps } from "./dream.js";
export {
  DREAM_BATCH_FACTS,
  DREAM_MIN_EXPLICIT_FACTS,
  dreamObserverMemories,
  factProvenance,
  observersDueForDream,
} from "./dream.js";
export type {
  EmbeddingConnection,
  EmbeddingConnection as ReembedConnection,
  EmbeddingResult,
} from "./embedding-client.js";
export {
  EmbeddingClient,
  embeddingToVectorLiteral,
  MAX_EMBEDDING_DIMENSIONS,
  probeEmbeddingConnection,
} from "./embedding-client.js";
export type { ExtractedFact, MemoryExtractDeps } from "./extract.js";
export {
  EXTRACT_BATCH_MESSAGES,
  extractThreadMemories,
} from "./extract.js";
export type { MemoryCompletionRequest } from "./llm.js";
export { memoryComplete, parseMemoryJson } from "./llm.js";
export type { MemoryMaintenanceDeps } from "./maintenance.js";
export { createMemoryMaintenance } from "./maintenance.js";
export type { NativeMemoryDeps } from "./provider.js";
export {
  createNativeProvider,
  NativeMemoryProvider,
} from "./provider.js";
export { reembedStaleFacts } from "./reembed.js";
export type {
  NativeMemorySettings,
  NativeMemoryStateView,
  NativeMemoryStatus,
} from "./state.js";
export {
  NATIVE_EMBEDDING_SECRET_KIND,
  NATIVE_PROVIDER_ID,
  readNativeMemoryState,
  resolveEmbeddingConnection,
  updateNativeMemorySettings,
} from "./state.js";
export type { NativeFact, NativeFactInput } from "./store.js";
export {
  clearFactEmbeddings,
  deleteFact,
  expireFacts,
  factsNeedingReembedding,
  getFact,
  insertFacts,
  listFactObservers,
  listFacts,
  observerLabel,
  recallObservers,
  reciprocalRankFusion,
  searchFacts,
  setFactEmbedding,
  supersedeFacts,
} from "./store.js";
