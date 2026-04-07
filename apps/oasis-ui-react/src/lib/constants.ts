import {
  Ear, Brain, GitBranch, Sparkles, MessageSquare, Database,
  CheckCircle2, Wrench, Play, ListChecks, Camera, Lightbulb,
} from 'lucide-react';
import type { ElementType } from 'react';

const getServiceUrl = (port: number) => {
  const host = window.location.hostname === 'localhost' ? 'localhost' : window.location.hostname;
  return `${window.location.protocol}//${host}:${port}`;
};

export const OASIS_BASE_URL = getServiceUrl(8000);
export const VOICE_AGENT_URL = `${OASIS_BASE_URL}/api/v1/voice-proxy`;
export const MOBILE_PAIRING_URL = `${OASIS_BASE_URL}/api/v1/dev-agent/mobile`;
// Keep this in sync with the voice-agent's AudioTranscriber._silence_threshold (seconds)
export const VOICE_SILENCE_CUTOFF_SECONDS = 5;

export interface PipelineStage {
  key: string;
  label: string;
  icon: ElementType;
}

export const COMPLEX_PIPELINE_STAGES: PipelineStage[] = [
  { key: 'InteractionReceived', label: 'Received', icon: Ear },
  { key: 'SemanticParsed', label: 'Interpreting', icon: Brain },
  { key: 'GraphConstructed', label: 'Graph built', icon: GitBranch },
  { key: 'DecisionFinalized', label: 'Decision', icon: Sparkles },
  { key: 'ResponseGenerated', label: 'Generating', icon: MessageSquare },
  { key: 'MemoryUpdated', label: 'Memory saved', icon: Database },
];

export const CASUAL_PIPELINE_STAGES: PipelineStage[] = [
  { key: 'InteractionReceived', label: 'Received', icon: Ear },
  { key: 'SemanticParsed', label: 'Interpreting', icon: Brain },
  { key: 'LlmCallCompleted', label: 'Thinking', icon: Sparkles },
  { key: 'ResponseGenerated', label: 'Responding', icon: MessageSquare },
];

export const TEACHING_PIPELINE_STAGES: PipelineStage[] = [
  { key: 'InteractionReceived', label: 'Received', icon: Ear },
  { key: 'SemanticParsed', label: 'Interpreting', icon: Brain },
  { key: 'LlmCallCompleted', label: 'Validating', icon: Sparkles },
  { key: 'TeachingValidationComplete', label: 'Validated', icon: CheckCircle2 },
  { key: 'ResponseGenerated', label: 'Responding', icon: MessageSquare },
];

export const TOOL_PIPELINE_STAGES: PipelineStage[] = [
  { key: 'InteractionReceived', label: 'Received', icon: Ear },
  { key: 'SemanticParsed', label: 'Interpreting', icon: Brain },
  { key: 'ToolPlanningStarted', label: 'Planning', icon: Wrench },
  { key: 'ToolPlanReady', label: 'Plan ready', icon: ListChecks },
  { key: 'ThoughtsValidated', label: 'Thinking', icon: Lightbulb },
  { key: 'ToolCallStarted', label: 'Executing', icon: Play },
  { key: 'SnapshotCreated', label: 'Snapshot', icon: Camera },
  { key: 'ToolUseComplete', label: 'Complete', icon: CheckCircle2 },
  { key: 'ResponseGenerated', label: 'Generating', icon: MessageSquare },
];
