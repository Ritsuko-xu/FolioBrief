# FolioBrief Architecture & Project Structure

## 1. Software Architecture Diagram

FolioBrief runs as a local-first macOS desktop application (via Electron) or standalone local web server, keeping all documents, PDFs, reading history, and AI traces stored locally on disk while calling the Google Gemini API from the Node.js backend.

```mermaid
flowchart TB
  subgraph Desktop["Runtime Shells"]
    MAC["macOS Electron Shell<br/>electron/main.ts + preload.ts<br/>Data: ~/Library/Application Support/FolioBrief/data"]
    CLI["Web / CLI Server<br/>server.ts (:3000)"]
    BOOT["Shared Bootstrapper<br/>server/bootstrap.ts<br/>(Express + DB Recovery + Static/Vite)"]
    MAC --> BOOT
    CLI --> BOOT
  end

  subgraph Client["Frontend Studio (React 19 + Vite + Tailwind CSS)"]
    SHELL["App.tsx + useStudioState.ts"]
    LIB["LibrarySidebar.tsx"]
    INGEST["IngestionView.tsx"]
    PDFVIEW["PdfAnnotatorCanvas.tsx<br/>(pdfjs-dist Fit-Width + Overlays)"]
    BRIEF["BriefCanvas.tsx"]
    CHAT["SideChatPanel.tsx<br/>(SSE Streaming + Undo)"]
    MEMUI["MemoryView.tsx + DiagnosticsView.tsx"]
    API["src/api/client.ts<br/>(REST, SSE, Blob Downloads)"]

    SHELL --> LIB & INGEST & PDFVIEW & BRIEF & CHAT & MEMUI
    LIB & INGEST & CHAT & MEMUI --> API
  end

  subgraph Backend["Backend Services (Express + Node.js)"]
    ROUTER["Express HTTP / SSE Router<br/>server/app.ts (/api/*)"]

    subgraph PDF["Ingestion & PDF Engine (server/pdf/)"]
      URL["urlIngestor.ts<br/>(SSRF Guard + Fetch)"]
      HTML["htmlArticleExtractor.ts<br/>(Readability + JSDOM)"]
      ARTRENDER["articlePdfRenderer.ts<br/>(Styled Source PDF)"]
      EXTRACTOR["extractor.ts<br/>(pdfjs-dist Page & Rect Index)"]
      GEN["generator.ts + textLayout.ts<br/>(Brief PDF & Annotated PDF)"]
      URL --> HTML --> ARTRENDER
    end

    subgraph AI["AI Agents & Memory (server/ai/ & server/memory/)"]
      PIPE["SynthesisPipeline<br/>server/pipeline/synthesisPipeline.ts"]
      SYNTH["documentSynthesisAgent.ts<br/>(Brief + Quote Highlights)"]
      SIDECHAT["sideChatRevisionAgent.ts<br/>(Streaming + Preference Distillation)"]
      TOOLS["agentTools.ts<br/>(Section & Highlight Mutations)"]
      RET["MemoryContextRetriever<br/>(Embeddings + FTS5 Fallback)"]
      GEMINI["geminiClient.ts<br/>(@google/genai SDK)"]

      PIPE --> EXTRACTOR
      PIPE --> RET
      PIPE --> SYNTH
      PIPE --> GEN
      SIDECHAT --> RET
      SIDECHAT --> TOOLS
      TOOLS --> GEN
      SYNTH & SIDECHAT --> GEMINI
    end

    subgraph Store["Local Persistence & Logs (server/)"]
      DB["FolioDatabase (SQLite WAL + FTS5)<br/>Document / Analysis / Chat / Memory Repos"]
      FS["FileStorageManager<br/>(Atomic Temp Writes + Version Pruning)"]
      LOG["AppLogger<br/>(Secret-Redacted JSONL Logs)"]
    end

    ROUTER --> URL & ARTRENDER & GEN & PIPE & SIDECHAT & DB & FS
    PIPE & TOOLS & RET --> DB
    PIPE & TOOLS --> FS
    ROUTER & PIPE & SIDECHAT --> LOG
  end

  subgraph External["External & Evaluation"]
    GAPI[("Google Gemini API")]
    PFOO["Promptfoo Eval Suites<br/>evals/*.yaml + providers/"]
  end

  API <-->|"HTTP JSON / Blob / SSE"| ROUTER
  BOOT --> ROUTER
  GEMINI <-->|"HTTPS"| GAPI
  PFOO --> SYNTH & SIDECHAT
```

---

## 2. Class & Domain Model Diagram

The backend follows a repository-backed database facade (`FolioDatabase`) paired with dedicated storage (`FileStorageManager`), logging (`AppLogger`), cross-document retrieval (`MemoryContextRetriever`), and background orchestration (`SynthesisPipeline`).

```mermaid
classDiagram
  direction TB

  class FolioDatabase {
    +db: Database
    +documents: DocumentRepository
    +analyses: AnalysisRepository
    +chat: ChatRepository
    +memory: MemoryRepository
    +recoverInterruptedJobs() number
    +createDocument(input) DocumentRecord
    +findDocumentByContentHash(hash) DocumentRecord?
    +findDocumentByUrl(url) DocumentRecord?
    +listDocuments(search?) DocumentListItem[]
    +createAnalysisVersion(input) AnalysisVersion
    +revertToVersion(docId, versionNumber) AnalysisVersion?
    +addChatMessage(input) ChatMessage
    +recordToolTrace(input) ToolTraceRecord
    +upsertMemoryPreference(input) MemoryProfileRecord
    +getHealthInfo() HealthInfo
    +close() void
  }

  class DocumentRepository {
    -db: Database
    -logger: StructuredLogger?
    +create(input) DocumentRecord
    +update(id, patch) DocumentRecord?
    +getById(id) DocumentRecord?
    +list(search?) DocumentListItem[]
    +searchFts(query, limit) FtsMatch[]
    +listWithEmbeddings(excludeId?) EmbeddedDoc[]
    +recoverInterruptedJobs() number
    +delete(id) boolean
  }

  class AnalysisRepository {
    -db: Database
    -logger: StructuredLogger?
    +createVersion(input) AnalysisVersion
    +updatePdfPaths(versionId, patch) void
    +getLatest(documentId) AnalysisVersion?
    +getVersion(documentId, versionNumber) AnalysisVersion?
    +listVersions(documentId) VersionSummary[]
    +revertToVersion(documentId, targetVersion) AnalysisVersion?
  }

  class ChatRepository {
    -db: Database
    -logger: StructuredLogger?
    +addMessage(input) ChatMessage
    +listMessages(documentId) ChatMessage[]
    +recordTrace(input) ToolTraceRecord
    +listTracesByDocument(documentId, limit) ToolTraceRecord[]
    +listRecentTraces(limit) ToolTraceRecord[]
  }

  class MemoryRepository {
    -db: Database
    +upsert(input) MemoryProfileRecord
    +getById(id) MemoryProfileRecord?
    +list() MemoryProfileRecord[]
    +delete(id) boolean
  }

  class FileStorageManager {
    +baseDataDir: string
    +pdfsDir: string
    +logsDir: string
    +getSourcePdfPath(documentId) string
    +getBriefPdfPath(documentId, versionNumber) string
    +getAnnotatedPdfPath(documentId, versionNumber) string
    +writeFileAtomic(targetPath, data) void
    +pruneOldVersionPdfs(documentId, keepVersion) void
    +cleanOrphanTempFiles() number
    +getStorageStats() StorageStats
  }

  class AppLogger {
    -logDir: string
    -ringBuffer: LogEntry[]
    -maxBufferSize: number
    +info(module, message, meta?, requestId?) LogEntry
    +warn(module, message, meta?, requestId?) LogEntry
    +error(module, message, meta?, requestId?) LogEntry
    +getRecentLogs(limit) LogEntry[]
  }

  class SynthesisPipeline {
    -db: FolioDatabase
    -storage: FileStorageManager
    -logger: AppLogger
    -retriever: MemoryContextRetriever
    -synthesize: DocumentSynthesizer
    -embed: TextEmbedder
    +run(documentId, requestId?) Promise~void~
  }

  class MemoryContextRetriever {
    -db: FolioDatabase
    +findRelatedDocuments(input) RelatedReadingMatch[]
    +buildPersonalizedContextBlock(input) PersonalizedContext
  }

  class DocumentRecord {
    +id: string
    +title: string
    +sourceType: SourceType
    +sourceUrl: string?
    +jobStatus: JobStatus
    +pageIndex: PageIndexEntry[]
    +embeddingVector: number[]?
  }

  class AnalysisVersion {
    +id: string
    +documentId: string
    +versionNumber: number
    +summary: string
    +keyInsights: string[]
    +improvements: string[]
    +openQuestions: string[]
    +highlights: HighlightItem[]
    +annotatedPdfDirty: boolean
  }

  class HighlightItem {
    +id: string
    +page: number
    +quoteAnchor: string
    +category: HighlightCategory
    +comment: string
    +rects: HighlightRect[]?
  }

  class ChatMessage {
    +id: string
    +documentId: string
    +role: string
    +content: string
    +referencedHighlightIds: string[]
    +appliedVersionNumber: number?
  }

  class ToolTraceRecord {
    +id: string
    +documentId: string
    +model: string
    +toolName: string
    +status: string
    +beforeVersion: number?
    +afterVersion: number?
  }

  class MemoryProfileRecord {
    +id: string
    +preferenceKey: string
    +learnedRule: string
    +confidence: number
  }

  FolioDatabase *-- DocumentRepository : composes
  FolioDatabase *-- AnalysisRepository : composes
  FolioDatabase *-- ChatRepository : composes
  FolioDatabase *-- MemoryRepository : composes

  SynthesisPipeline --> FolioDatabase : persists jobs & versions
  SynthesisPipeline --> FileStorageManager : writes Brief PDFs
  SynthesisPipeline --> AppLogger : logs progress/errors
  SynthesisPipeline *-- MemoryContextRetriever : retrieves context
  MemoryContextRetriever --> FolioDatabase : queries embeddings & FTS5

  DocumentRecord "1" o-- "*" AnalysisVersion : versions
  AnalysisVersion "1" *-- "*" HighlightItem : annotations
  DocumentRecord "1" o-- "*" ChatMessage : conversation
  ChatMessage "1" o-- "*" ToolTraceRecord : tool traces
```

---

## 3. Project & Folder Structure

```text
foliobrief/
├── package.json                  # Single manifest for all runtime, desktop, test, and eval dependencies
├── .env.example                  # Environment variable template (no real keys)
├── server.ts                     # Web/CLI HTTP server entrypoint (port 3000)
├── vite.config.ts                # Vite + React + Tailwind CSS build configuration
├── electron/                     # Native macOS desktop shell
│   ├── main.ts                   # Electron lifecycle, macOS menu bar, local Express bootstrap
│   └── preload.ts                # Sandboxed contextBridge preload script
├── server/                       # Backend Express API, SQLite persistence, PDF engine, AI agents
│   ├── app.ts                    # REST + SSE API routes (/api/documents, /pdf/*, /chat, /memory)
│   ├── bootstrap.ts              # Shared server startup & graceful shutdown (web + Electron)
│   ├── db.ts                     # FolioDatabase facade over WAL SQLite + FTS5
│   ├── storage.ts                # Atomic PDF file storage and old-version pruning
│   ├── logger.ts                 # Secret-redacted rotating JSONL logger
│   ├── ai/
│   │   ├── geminiClient.ts       # @google/genai client factory, retries, and embeddings
│   │   ├── documentSynthesisAgent.ts  # Structured brief & highlight synthesis
│   │   ├── sideChatRevisionAgent.ts   # Multi-turn SSE side-chat & preference distillation
│   │   └── agentTools.ts         # Deterministic revision tools creating immutable vN snapshots
│   ├── db/                       # Schema migrations, row guards, and domain repositories
│   ├── memory/
│   │   └── retriever.ts          # Cosine embedding + FTS5 cross-document context retriever
│   ├── pdf/
│   │   ├── articleTypes.ts       # Structured article block contracts
│   │   ├── urlIngestor.ts        # SSRF-guarded URL fetcher
│   │   ├── htmlArticleExtractor.ts    # Readability + JSDOM block extractor
│   │   ├── articlePdfRenderer.ts # Styled editorial Source PDF renderer for web/text inputs
│   │   ├── extractor.ts          # pdfjs-dist page/word bounding-box indexer & quote matcher
│   │   ├── generator.ts          # Executive Brief PDF & Annotated PDF (/Highlight + /Text) generator
│   │   └── textLayout.ts         # Shared WinAnsi sanitization and line-wrapping utilities
│   ├── pipeline/
│   │   └── synthesisPipeline.ts  # Background ingestion -> synthesis -> Brief PDF pipeline
│   └── utils/
│       └── jsonParser.ts         # Resilient structured JSON extraction helpers
├── src/                          # React 19 frontend studio
│   ├── App.tsx                   # Top-level studio shell
│   ├── api/client.ts             # Typed HTTP, SSE stream, and Blob download client
│   ├── hooks/useStudioState.ts   # Library polling, active workspace, chat streaming state
│   ├── shared/types.ts           # Shared TypeScript contracts across client and server
│   └── components/               # Workspace views (PdfAnnotatorCanvas, BriefCanvas, SideChatPanel, etc.)
├── evals/                        # Promptfoo evaluation suites and custom providers
├── tests/                        # Vitest unit and integration tests (client/ and server/)
└── doc/                          # Architecture diagrams, class diagrams, and visual assets
```
