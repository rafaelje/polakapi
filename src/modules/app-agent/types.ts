export interface DetectedCli {
  id: string;
  label: string;
  command: string;
  path: string | null;
}

export interface AgentLaunchSpec {
  cli: string;
  cwd: string;
  command: string;
  args: string[];
}

export interface ControlRequest {
  id: number;
  method: string;
  params: unknown;
}
