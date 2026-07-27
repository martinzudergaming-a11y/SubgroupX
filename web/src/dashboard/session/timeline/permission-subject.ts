import type { PermissionRequestPayload } from "@shared/protocol";
import type { TranslationKey } from "../../../i18n/en";

export type PermissionSubjectKind = "command" | "path" | "prose";

export interface PermissionSubject {
  titleKey: TranslationKey;
  confirmKey: TranslationKey;
  refuseKey: TranslationKey;
  subject: string;
  kind: PermissionSubjectKind;
}

const KNOWN: Record<string, { verb: "Run" | "Write" | "Edit" | "Read" | "List"; field: "command" | "path" }> = {
  bash: { verb: "Run", field: "command" },
  write_file: { verb: "Write", field: "path" },
  edit_file: { verb: "Edit", field: "path" },
  read_file: { verb: "Read", field: "path" },
  list_files: { verb: "List", field: "path" },
};

export function permissionSubject(request: Pick<PermissionRequestPayload, "toolName" | "summary" | "command" | "path">): PermissionSubject {
  const known = KNOWN[request.toolName];
  if (known) {
    const value = known.field === "command" ? request.command : request.path;
    if (value && value.trim()) {
      return {
        titleKey: `perm.ask${known.verb}`,
        confirmKey: `perm.do${known.verb}`,
        refuseKey: `perm.dont${known.verb}`,
        subject: value,
        kind: known.field,
      };
    }
  }
  return {
    titleKey: "perm.askGeneric",
    confirmKey: "perm.doAllow",
    refuseKey: "perm.dontAllow",
    subject: request.summary,
    kind: "prose",
  };
}
