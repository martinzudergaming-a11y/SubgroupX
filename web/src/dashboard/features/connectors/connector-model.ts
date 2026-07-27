import type { ConnectorInfo, SshTargetInfo } from "../../../platform/api.ts";

export type TestState = { testing: boolean; ok?: boolean; message?: string };

export type ConnectorsData = {
  enabled: boolean;
  loaded: boolean;
  targets: SshTargetInfo[];
  connectors: ConnectorInfo[];
};

export const connectorsDataInit: ConnectorsData = {
  enabled: false,
  loaded: false,
  targets: [],
  connectors: [],
};

export type ConnectorsDataAction =
  | { type: "loaded"; enabled: boolean; targets: SshTargetInfo[]; connectors: ConnectorInfo[] }
  | { type: "loadFailed" }
  | { type: "connectors"; connectors: ConnectorInfo[] }
  | { type: "targets"; targets: SshTargetInfo[] }
  | { type: "removeTarget"; id: string }
  | { type: "removeConnector"; id: string };

export function connectorsDataReducer(state: ConnectorsData, action: ConnectorsDataAction): ConnectorsData {
  switch (action.type) {
    case "loaded":
      return { enabled: action.enabled, loaded: true, targets: action.targets, connectors: action.connectors };
    case "connectors":
      return JSON.stringify(action.connectors) === JSON.stringify(state.connectors)
        ? state
        : { ...state, connectors: action.connectors };
    case "targets":
      return { ...state, targets: action.targets };
    case "loadFailed":
      return { ...state, loaded: true };
    case "removeTarget":
      return { ...state, targets: state.targets.filter((target) => target.id !== action.id) };
    case "removeConnector":
      return { ...state, connectors: state.connectors.filter((connector) => connector.id !== action.id) };
  }
}

export type ConnectorForm = {
  name: string;
  root: string;
  busy: boolean;
  error: string;
  command: string;
  insecure: boolean;
};

export const connectorFormInit: ConnectorForm = {
  name: "",
  root: "~/.agent-web/workspaces",
  busy: false,
  error: "",
  command: "",
  insecure: false,
};

export type ConnectorFormAction =
  | { type: "set"; field: "name" | "root"; value: string }
  | { type: "submitStart" }
  | { type: "submitOk"; command: string; insecure: boolean }
  | { type: "submitError"; error: string }
  | { type: "submitEnd" };

export function connectorFormReducer(state: ConnectorForm, action: ConnectorFormAction): ConnectorForm {
  switch (action.type) {
    case "set":
      return { ...state, [action.field]: action.value };
    case "submitStart":
      return { ...state, busy: true, error: "", command: "" };
    case "submitOk":
      return { ...state, name: "", command: action.command, insecure: action.insecure };
    case "submitError":
      return { ...state, error: action.error };
    case "submitEnd":
      return { ...state, busy: false };
  }
}

export type SshForm = {
  label: string;
  host: string;
  port: string;
  username: string;
  privateKey: string;
  busy: boolean;
  error: string;
};

export const sshFormInit: SshForm = {
  label: "",
  host: "",
  port: "22",
  username: "",
  privateKey: "",
  busy: false,
  error: "",
};

export type SshFormAction =
  | { type: "set"; field: "label" | "host" | "port" | "username" | "privateKey"; value: string }
  | { type: "submitStart" }
  | { type: "submitOk" }
  | { type: "submitError"; error: string }
  | { type: "submitEnd" };

export function sshFormReducer(state: SshForm, action: SshFormAction): SshForm {
  switch (action.type) {
    case "set":
      return { ...state, [action.field]: action.value };
    case "submitStart":
      return { ...state, busy: true, error: "" };
    case "submitOk":
      return { ...state, label: "", host: "", port: "22", username: "", privateKey: "" };
    case "submitError":
      return { ...state, error: action.error };
    case "submitEnd":
      return { ...state, busy: false };
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseSshConfig(text: string): Partial<Pick<SshForm, "label" | "host" | "port" | "username">> {
  const out: Partial<Pick<SshForm, "label" | "host" | "port" | "username">> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)[\s=]+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "host" && !out.label) out.label = value.split(/\s+/)[0];
    else if (key === "hostname") out.host = value;
    else if (key === "user") out.username = value;
    else if (key === "port" && /^\d+$/.test(value)) out.port = value;
  }
  if (!out.host && out.label && /[.:]/.test(out.label)) out.host = out.label;
  return out;
}
