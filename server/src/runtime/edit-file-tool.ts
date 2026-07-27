import {
  createEditTool as createPiEditTool,
  type EditToolDetails,
  type EditToolInput,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EditResult } from "../../../shared/src/protocol.ts";
import type { PiWorkspaceAdapter } from "./pi-workspace-adapter.ts";

export interface EditFileResult extends EditToolDetails {
  path: string;
  replacements: number;
}

const MAX_PERSISTED_PATCH = 120_000;

export function extractEditResult(result: unknown): EditResult | undefined {
  const details = (result as { details?: Partial<EditFileResult> } | null | undefined)?.details;
  if (!details || typeof details.patch !== "string" || typeof details.replacements !== "number") return undefined;
  const truncated = details.patch.length > MAX_PERSISTED_PATCH;
  return {
    patch: truncated
      ? `${details.patch.slice(0, MAX_PERSISTED_PATCH)}\n...[patch truncated ${details.patch.length - MAX_PERSISTED_PATCH} chars]`
      : details.patch,
    firstChangedLine: typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined,
    replacements: details.replacements,
    truncated,
  };
}

export function createEditFileTool(workspace: PiWorkspaceAdapter): AgentTool<any, EditFileResult> {
  const piEdit = createPiEditTool(workspace.cwd, { operations: workspace.editOperations });

  return {
    ...piEdit,
    name: "edit_file",
    label: "Edit file",
    parameters: {
      ...piEdit.parameters,
      properties: {
        ...piEdit.parameters.properties,
        path: {
          ...piEdit.parameters.properties.path,
          description: "Workspace-relative path to the file to edit.",
        },
      },
    },
    description:
      "Edit one workspace file with one or more precise replacements. Every edits[].oldText must " +
      "identify one unique, non-overlapping region of the original file. Put separate changes in " +
      "one edits array; merge nearby or overlapping changes into one entry.",
    prepareArguments(input: unknown): EditToolInput {
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const args = { ...(input as Record<string, unknown>) };
        if (typeof args.old === "string" && typeof args.new === "string") {
          args.oldText = args.old;
          args.newText = args.new;
          delete args.old;
          delete args.new;
        }
        return piEdit.prepareArguments?.(args) ?? (args as EditToolInput);
      }
      return piEdit.prepareArguments?.(input as EditToolInput) ?? (input as EditToolInput);
    },
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<EditFileResult>> {
      return workspace.runMutation(async () => {
        const editParams = params as EditToolInput;
        const result = await piEdit.execute(toolCallId, editParams, signal, onUpdate);
        const details = result.details as EditToolDetails | undefined;
        return {
          ...result,
          details: {
            diff: details?.diff ?? "",
            patch: details?.patch ?? "",
            firstChangedLine: details?.firstChangedLine,
            path: editParams.path,
            replacements: editParams.edits.length,
          },
        };
      }, signal);
    },
  };
}
