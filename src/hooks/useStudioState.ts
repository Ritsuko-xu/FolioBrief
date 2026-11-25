/** Custom React hook managing studio navigation, library polling, document actions, and SSE chat streaming. */
import { useCallback, useEffect, useState } from 'react';
import type {
  CanvasViewMode,
  ChatMessage,
  DocumentDetailResponse,
  DocumentListItem,
  HighlightItem,
  ToolTraceRecord,
} from '../shared/types.ts';
import { apiClient } from '../api/client.ts';
import type { ActiveRoute } from '../components/TopBar.tsx';

/** Encapsulates all client-side state, background polling, and API handlers for FolioBrief. */
export function useStudioState() {
  const [activeRoute, setActiveRoute] = useState<ActiveRoute>('workspace');
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [viewMode, setViewMode] = useState<CanvasViewMode>('split');
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [attachedHighlight, setAttachedHighlight] = useState<HighlightItem | null>(null);

  const [streamingText, setStreamingText] = useState('');
  const [streamingTraces, setStreamingTraces] = useState<ToolTraceRecord[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr));
    }, 3500);
  }, []);

  const refreshLibrary = useCallback(async (q?: string) => {
    try {
      const list = await apiClient.listDocuments(q);
      setDocuments(list);
    } catch {
      // ignore transient poll error
    }
  }, []);

  const loadDocumentDetail = useCallback(
    async (id: string) => {
      try {
        const data = await apiClient.getDocument(id);
        setDetail(data);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshLibrary(searchQuery);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery, refreshLibrary]);

  useEffect(() => {
    if (!selectedDocId) {
      setDetail(null);
      return;
    }
    void loadDocumentDetail(selectedDocId);
  }, [selectedDocId, loadDocumentDetail]);

  // Poll active document while ingestion/synthesis is running
  useEffect(() => {
    if (!detail) return;
    const status = detail.document.jobStatus;
    if (status === 'queued' || status === 'extracting' || status === 'synthesizing') {
      const interval = setInterval(() => {
        void loadDocumentDetail(detail.document.id);
        void refreshLibrary(searchQuery);
      }, 1500);
      return () => clearInterval(interval);
    }
  }, [detail, loadDocumentDetail, refreshLibrary, searchQuery]);

  const selectDocument = useCallback((id: string) => {
    setSelectedDocId(id);
    setActiveHighlightId(null);
    setAttachedHighlight(null);
    setChatError(null);
  }, []);

  const startNewReading = useCallback(() => {
    setSelectedDocId(null);
    setActiveRoute('workspace');
  }, []);

  const handleUploadPdf = async (file: File) => {
    const { documentId, deduplicated } = await apiClient.uploadPdf(file);
    await refreshLibrary(searchQuery);
    setSelectedDocId(documentId);
    setActiveRoute('workspace');
    if (deduplicated) {
      showToast('Opened existing reading from library (already processed).');
    }
  };

  const handleIngestUrl = async (url: string) => {
    const { documentId, deduplicated } = await apiClient.ingestUrl(url);
    await refreshLibrary(searchQuery);
    setSelectedDocId(documentId);
    setActiveRoute('workspace');
    if (deduplicated) {
      showToast('Opened existing article from library (already processed).');
    }
  };

  const handleIngestText = async (input: { title: string; text: string; sourceUrl?: string }) => {
    const { documentId, deduplicated } = await apiClient.ingestText(input);
    await refreshLibrary(searchQuery);
    setSelectedDocId(documentId);
    setActiveRoute('workspace');
    if (deduplicated) {
      showToast('Opened existing reading from library (already processed).');
    }
  };

  const handleResume = async (id: string) => {
    try {
      await apiClient.resumeDocument(id);
      setSelectedDocId(id);
      setActiveRoute('workspace');
      await refreshLibrary(searchQuery);
      await loadDocumentDetail(id);
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.deleteDocument(id);
      if (selectedDocId === id) {
        setSelectedDocId(null);
        setDetail(null);
      }
      await refreshLibrary(searchQuery);
      showToast('Removed reading from library.');
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleRevert = async (versionNumber: number) => {
    if (!detail) return;
    try {
      const res = await apiClient.revertVersion(detail.document.id, versionNumber);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              latestVersion: res.latestVersion,
              versions: res.versions,
            }
          : prev
      );
      showToast(`Reverted analysis to v${versionNumber} (saved as v${res.latestVersion.versionNumber}).`);
      void refreshLibrary(searchQuery);
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleSendMessage = async (message: string, referencedHighlightIds: string[]) => {
    if (!detail) return;
    setChatError(null);
    setIsStreaming(true);
    setStreamingText('');
    setStreamingTraces([]);

    const optimisticUser: ChatMessage = {
      id: `tmp-${Date.now()}`,
      documentId: detail.document.id,
      role: 'user',
      content: message,
      referencedHighlightIds,
      appliedVersionNumber: null,
      createdAt: new Date().toISOString(),
    };

    setDetail((prev) =>
      prev ? { ...prev, chatMessages: [...prev.chatMessages, optimisticUser] } : prev
    );

    await apiClient.streamChat({
      documentId: detail.document.id,
      message,
      referencedHighlightIds,
      onDelta: (chunk) => {
        setStreamingText((prev) => prev + chunk);
      },
      onRevision: (payload) => {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                latestVersion: payload.latestVersion,
                versions: payload.versions,
              }
            : prev
        );
        showToast(`Analysis updated to v${payload.latestVersion.versionNumber}.`);
      },
      onTrace: (trace) => {
        setStreamingTraces((prev) => [...prev, trace]);
      },
      onDone: async () => {
        setIsStreaming(false);
        setStreamingText('');
        setStreamingTraces([]);
        await loadDocumentDetail(detail.document.id);
        await refreshLibrary(searchQuery);
      },
      onError: (errMsg) => {
        setIsStreaming(false);
        setStreamingText('');
        setStreamingTraces([]);
        setChatError(errMsg);
      },
    });
  };

  return {
    activeRoute,
    setActiveRoute,
    documents,
    searchQuery,
    setSearchQuery,
    selectedDocId,
    setSelectedDocId,
    selectDocument,
    startNewReading,
    detail,
    viewMode,
    setViewMode,
    activeHighlightId,
    setActiveHighlightId,
    attachedHighlight,
    setAttachedHighlight,
    streamingText,
    streamingTraces,
    isStreaming,
    chatError,
    toastMsg,
    showToast,
    handleUploadPdf,
    handleIngestUrl,
    handleIngestText,
    handleResume,
    handleDelete,
    handleRevert,
    handleSendMessage,
  };
}
