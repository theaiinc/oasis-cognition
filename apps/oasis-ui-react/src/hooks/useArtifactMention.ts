import { useState, useCallback, useRef, useEffect } from 'react';
import type { Artifact } from '@/lib/artifact-api';
import { listArtifacts } from '@/lib/artifact-api';

interface UseArtifactMentionOptions {
  inputText: string;
  cursorPosition: number;
  activeProjectId?: string;
}

interface UseArtifactMentionReturn {
  showDropdown: boolean;
  filteredArtifacts: Artifact[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  handleKeyDown: (e: React.KeyboardEvent) => boolean; // returns true if event was consumed
  insertMention: (artifact: Artifact) => { newText: string; newCursorPos: number };
  closeDropdown: () => void;
}

export function useArtifactMention({
  inputText,
  cursorPosition,
  activeProjectId,
}: UseArtifactMentionOptions): UseArtifactMentionReturn {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const fetchedRef = useRef(false);
  const lastProjectRef = useRef<string | undefined>(undefined);

  // Fetch artifacts on first @ trigger or when project changes
  const fetchArtifacts = useCallback(async () => {
    try {
      const list = await listArtifacts(activeProjectId);
      setArtifacts(list.filter((a) => a.status === 'ready'));
      fetchedRef.current = true;
      lastProjectRef.current = activeProjectId;
    } catch {
      // silent - just keep existing list
    }
  }, [activeProjectId]);

  // Detect @ trigger: scan backwards from cursor to find @ that starts a mention query
  const getAtQuery = useCallback((): string | null => {
    if (cursorPosition <= 0) return null;
    const beforeCursor = inputText.slice(0, cursorPosition);
    // Find the last @ that is either at position 0 or preceded by a space/newline
    const lastAt = beforeCursor.lastIndexOf('@');
    if (lastAt === -1) return null;
    // @ must be at start of string or preceded by whitespace
    if (lastAt > 0 && !/\s/.test(beforeCursor[lastAt - 1])) return null;
    // Text between @ and cursor must not contain newline or another @
    const query = beforeCursor.slice(lastAt + 1);
    if (query.includes('\n') || query.includes('@')) return null;
    // Don't trigger if it's already a completed mention @[...](...)
    if (/\[.*\]\(.*\)/.test(query)) return null;
    return query;
  }, [inputText, cursorPosition]);

  const atQuery = getAtQuery();
  const showDropdown = atQuery !== null;

  // Fetch when dropdown opens or project changes
  useEffect(() => {
    if (showDropdown && (!fetchedRef.current || lastProjectRef.current !== activeProjectId)) {
      void fetchArtifacts();
    }
  }, [showDropdown, fetchArtifacts, activeProjectId]);

  // Reset dropdown state when it opens/closes
  useEffect(() => {
    if (showDropdown && !dropdownOpen) {
      setDropdownOpen(true);
      setSelectedIndex(0);
    } else if (!showDropdown && dropdownOpen) {
      setDropdownOpen(false);
    }
  }, [showDropdown, dropdownOpen]);

  // Filter artifacts by query
  const filteredArtifacts = showDropdown
    ? artifacts
        .filter((a) => {
          if (!atQuery) return true;
          return a.name.toLowerCase().includes(atQuery.toLowerCase());
        })
        .slice(0, 8)
    : [];

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [atQuery]);

  const insertMention = useCallback(
    (artifact: Artifact): { newText: string; newCursorPos: number } => {
      const beforeCursor = inputText.slice(0, cursorPosition);
      const lastAt = beforeCursor.lastIndexOf('@');
      const before = inputText.slice(0, lastAt);
      const after = inputText.slice(cursorPosition);
      const mention = `@[${artifact.name}](${artifact.artifact_id}) `;
      const newText = before + mention + after;
      const newCursorPos = before.length + mention.length;
      return { newText, newCursorPos };
    },
    [inputText, cursorPosition],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showDropdown || filteredArtifacts.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredArtifacts.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredArtifacts.length) % filteredArtifacts.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return true; // caller should call insertMention with filteredArtifacts[selectedIndex]
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDropdownOpen(false);
        return true;
      }
      return false;
    },
    [showDropdown, filteredArtifacts.length],
  );

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
  }, []);

  return {
    showDropdown: showDropdown && dropdownOpen,
    filteredArtifacts,
    selectedIndex,
    setSelectedIndex,
    handleKeyDown,
    insertMention,
    closeDropdown,
  };
}
