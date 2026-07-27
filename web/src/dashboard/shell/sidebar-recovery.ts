import type { ViewType } from "../types";

export type ShellBranch =
  | "chat"
  | "view-header"
  | "placeholder";

export interface ShellBranchContext {
  hasShellTarget: boolean;
}

export function shellBranchFor(view: ViewType, ctx: ShellBranchContext): ShellBranch {
  if (view === "chat") return "chat";
  if (view === "shell") return ctx.hasShellTarget ? "view-header" : "placeholder";
  return "view-header";
}

export function needsSidebarFallback(branch: ShellBranch, leftSidebarOpen: boolean): boolean {
  return !leftSidebarOpen && branch === "placeholder";
}
