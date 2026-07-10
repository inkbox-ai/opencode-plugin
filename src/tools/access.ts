import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listContactAccessArgs = {
  contactId: z.string().describe("Contact UUID."),
};

const grantContactAccessArgs = {
  contactId: z.string().describe("Contact UUID."),
  identityId: z.string().describe("Agent identity UUID to grant.").optional(),
  wildcard: z
    .boolean()
    .describe("Set true to replace specific grants with wildcard access.")
    .optional(),
};

const revokeContactAccessArgs = {
  contactId: z.string().describe("Contact UUID."),
  identityId: z.string().describe("Agent identity UUID to revoke."),
};

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

type ListContactAccessArgs = z.infer<z.ZodObject<typeof listContactAccessArgs>>;
type GrantContactAccessArgs = z.infer<z.ZodObject<typeof grantContactAccessArgs>>;
type RevokeContactAccessArgs = z.infer<z.ZodObject<typeof revokeContactAccessArgs>>;
type ListNoteAccessArgs = z.infer<z.ZodObject<typeof listNoteAccessArgs>>;
type GrantNoteAccessArgs = z.infer<z.ZodObject<typeof grantNoteAccessArgs>>;
type RevokeNoteAccessArgs = z.infer<z.ZodObject<typeof revokeNoteAccessArgs>>;

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Access grants control which identities can see a contact or a note.
// Contacts support wildcard grants (every active identity sees the contact);
// note grants are strictly per-identity.
export function accessTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_contact_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description:
          "List which Inkbox identities can see a contact. Use before granting or revoking cross-identity contact access.",
        args: listContactAccessArgs,
        async execute(args: ListContactAccessArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const grants = await inkbox.contacts.access.list(args.contactId);
            return formatWithHeader(`Returned ${grants.length} contact access grant(s).`, grants);
          });
        },
      },
    },
    {
      name: "inkbox_grant_contact_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description:
          "Grant an Inkbox identity access to a contact, or grant wildcard access so every active identity can see it.",
        args: grantContactAccessArgs,
        async execute(args: GrantContactAccessArgs, _ctx) {
          return runTool(async () => {
            const identityId = hasString(args.identityId) ? args.identityId.trim() : undefined;
            if (args.wildcard === true && identityId) {
              throw new Error("Pass either identityId or wildcard=true, not both.");
            }
            if (args.wildcard !== true && !identityId) {
              throw new Error("identityId is required unless wildcard=true.");
            }
            const inkbox = await runtime.getClient();
            const grant = await inkbox.contacts.access.grant(args.contactId, {
              identityId,
              wildcard: args.wildcard === true,
            });
            return {
              title: `Granted access to contact ${args.contactId}`,
              output: formatWithHeader("Granted contact access.", grant),
            };
          });
        },
      },
    },
    {
      name: "inkbox_revoke_contact_access",
      group: "access",
      defaultEnabled: false,
      definition: {
        description: "Revoke one Inkbox identity's access to a contact.",
        args: revokeContactAccessArgs,
        async execute(args: RevokeContactAccessArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            await inkbox.contacts.access.revoke(args.contactId, args.identityId);
            return {
              title: `Revoked access to contact ${args.contactId}`,
              output: `Revoked identity ${args.identityId} access to contact ${args.contactId}.`,
            };
          });
        },
      },
    },
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
