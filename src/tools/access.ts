import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listNoteAccessArgs = {
  noteId: z.string().describe("Note UUID."),
};

const grantNoteAccessArgs = {
  noteId: z.string().describe("Note UUID."),
  identityId: z.string().describe("Agent identity UUID to grant."),
};

const revokeNoteAccessArgs = {
  noteId: z.string().describe("Note UUID."),
  identityId: z.string().describe("Agent identity UUID to revoke."),
};

type ListNoteAccessArgs = z.infer<z.ZodObject<typeof listNoteAccessArgs>>;
type GrantNoteAccessArgs = z.infer<z.ZodObject<typeof grantNoteAccessArgs>>;
type RevokeNoteAccessArgs = z.infer<z.ZodObject<typeof revokeNoteAccessArgs>>;

// Notes retain per-identity grants; contacts are organization-wide.
export function accessTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_note_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description:
          "List which Inkbox identities can see a note. Use before granting or revoking cross-identity note access.",
        args: listNoteAccessArgs,
        async execute(args: ListNoteAccessArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const grants = await inkbox.notes.access.list(args.noteId);
            return formatWithHeader(`Returned ${grants.length} note access grant(s).`, grants);
          });
        },
      },
    },
    {
      name: "inkbox_grant_note_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description: "Grant an Inkbox identity access to a note.",
        args: grantNoteAccessArgs,
        async execute(args: GrantNoteAccessArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const grant = await inkbox.notes.access.grant(args.noteId, args.identityId);
            return {
              title: `Granted access to note ${args.noteId}`,
              output: formatJson(grant),
            };
          });
        },
      },
    },
    {
      name: "inkbox_revoke_note_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description: "Revoke one Inkbox identity's access to a note.",
        args: revokeNoteAccessArgs,
        async execute(args: RevokeNoteAccessArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            await inkbox.notes.access.revoke(args.noteId, args.identityId);
            return {
              title: `Revoked access to note ${args.noteId}`,
              output: `Revoked identity ${args.identityId} access to note ${args.noteId}.`,
            };
          });
        },
      },
    },
  ];
}
