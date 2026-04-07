import { useState, useCallback } from 'react';
import { uploadArtifact } from '@/lib/artifact-api';

export interface PendingFile {
  id: string;
  file: File;
  name: string;
  uploading: boolean;
  artifactId?: string;
  error?: string;
}

interface UseQuickUploadReturn {
  pendingFiles: PendingFile[];
  addFiles: (files: File[], projectId?: string, language?: string) => void;
  removeFile: (id: string) => void;
  getReadyArtifactIds: () => string[];
  clearAll: () => void;
  hasUploading: boolean;
}

export function useQuickUpload(): UseQuickUploadReturn {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const addFiles = useCallback(
    (files: File[], projectId?: string, language?: string) => {
      const newEntries: PendingFile[] = files.map((file) => ({
        id: crypto?.randomUUID?.() || Math.random().toString(36).slice(2),
        file,
        name: file.name,
        uploading: true,
      }));

      setPendingFiles((prev) => [...prev, ...newEntries]);

      // Start uploading each file immediately
      for (const entry of newEntries) {
        uploadArtifact(entry.file, { project_id: projectId, language })
          .then((artifact) => {
            setPendingFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id
                  ? { ...f, uploading: false, artifactId: artifact.artifact_id }
                  : f,
              ),
            );
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error ? err.message : 'Upload failed';
            setPendingFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id
                  ? { ...f, uploading: false, error: message }
                  : f,
              ),
            );
          });
      }
    },
    [],
  );

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const getReadyArtifactIds = useCallback((): string[] => {
    return pendingFiles
      .filter((f) => f.artifactId && !f.uploading && !f.error)
      .map((f) => f.artifactId!);
  }, [pendingFiles]);

  const clearAll = useCallback(() => {
    setPendingFiles([]);
  }, []);

  const hasUploading = pendingFiles.some((f) => f.uploading);

  return {
    pendingFiles,
    addFiles,
    removeFile,
    getReadyArtifactIds,
    clearAll,
    hasUploading,
  };
}
