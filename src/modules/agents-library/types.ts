export interface AgentFile {
  id: string;
  title: string;
  content: string;
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  files: AgentFile[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentsState {
  agents: AgentDef[];
  schemaVersion: 1;
}

export interface AgentFileInput {
  title: string;
  content: string;
}

export interface AgentCreateInput {
  name: string;
  description: string;
  files: AgentFileInput[];
}

export interface AgentUpdateInput {
  name?: string;
  description?: string;
  files?: AgentFileInput[];
}
