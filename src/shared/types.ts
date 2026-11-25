/** Shared domain models and API response contracts used across backend and React client. */
export type SourceType = 'pdf' | 'url' | 'text';

export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'synthesizing'
  | 'ready'
  | 'interrupted'
  | 'failed';

export type HighlightCategory = 'claim' | 'improvement' | 'question';

export type CanvasViewMode = 'annotated' | 'brief' | 'split';

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightItem {
  id: string;
  page: number;
  quoteAnchor: string;
  category: HighlightCategory;
  comment: string;
  rects?: HighlightRect[];
}

export interface PageTextSpan {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageIndexEntry {
  page: number;
  width: number;
  height: number;
  fullText: string;
  spans: PageTextSpan[];
}

export interface AnalysisPayload {
  summary: string;
  keyInsights: string[];
  improvements: string[];
  openQuestions: string[];
  highlights: HighlightItem[];
}

export interface AnalysisVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  summary: string;
  keyInsights: string[];
  improvements: string[];
  openQuestions: string[];
  highlights: HighlightItem[];
  briefPdfPath: string | null;
  annotatedPdfPath: string | null;
  annotatedPdfDirty: boolean;
  revisionReason: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  sourceDomain: string | null;
  sourcePdfPath: string | null;
  contentHash: string | null;
  jobStatus: JobStatus;
  errorMessage: string | null;
  extractedText: string;
  pageIndex: PageIndexEntry[];
  pageCount: number;
  embeddingVector: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListItem {
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  sourceDomain: string | null;
  jobStatus: JobStatus;
  errorMessage: string | null;
  pageCount: number;
  latestVersionNumber: number | null;
  highlightCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetailResponse {
  document: Omit<DocumentRecord, 'pageIndex' | 'embeddingVector'> & {
    pageCount: number;
  };
  latestVersion: AnalysisVersion | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    revisionReason: string;
    createdAt: string;
  }>;
  chatMessages: ChatMessage[];
  relatedDocuments: Array<{
    id: string;
    title: string;
    sourceDomain: string | null;
    similarity: number;
    createdAt: string;
  }>;
}

export interface ChatMessage {
  id: string;
  documentId: string;
  role: 'user' | 'assistant';
  content: string;
  referencedHighlightIds: string[];
  appliedVersionNumber: number | null;
  traces?: ToolTraceRecord[];
  createdAt: string;
}

export interface ToolTraceRecord {
  id: string;
  documentId: string;
  chatMessageId: string | null;
  model: string;
  toolName: string;
  rawArgsJson: string;
  status: 'ok' | 'rejected' | 'error';
  resultSummary: string;
  beforeVersion: number | null;
  afterVersion: number | null;
  durationMs: number;
  createdAt: string;
}

export interface MemoryProfileRecord {
  id: string;
  preferenceKey: string;
  learnedRule: string;
  sourceEvidence: string;
  confidence: number;
  updatedAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  requestId?: string;
  module: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  status: 'healthy' | 'degraded';
  sqliteIntegrity: string;
  sqliteWalMode: string;
  pdfStorageBytes: number;
  pdfFileCount: number;
  orphanTempFiles: number;
  documentCount: number;
  interruptedJobs: number;
  recentLogs: LogEntry[];
  recentTraces: ToolTraceRecord[];
}
