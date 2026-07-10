import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listNotesArgs = {
  q: z.string().describe("Free-text search across title + body.").optional(),
  order: z.enum(["recent", "name"]).describe("Sort order. Defaults to recent.").optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

const getNoteArgs = {
  noteId: z.string().describe("UUID of the note."),
};

const createNoteArgs = {
  body: z.string().min(1).describe("Note body (free-form text or markdown)."),
  title: z.string().describe("Optional title.").optional(),
};

const updateNoteArgs = {
  noteId: z.string().describe("UUID of the note to update."),
  title: z.string().nullable().describe("New title, or null to clear.").optional(),
  body: z.string().min(1).optional(),
};

const deleteNoteArgs = {
  noteId: z.string().describe("UUID of the note to delete."),
};

type ListNotesArgs = z.infer<z.ZodObject<typeof listNotesArgs>>;
type GetNoteArgs = z.infer<z.ZodObject<typeof getNoteArgs>>;
type CreateNoteArgs = z.infer<z.ZodObject<typeof createNoteArgs>>;
type UpdateNoteArgs = z.infer<z.ZodObject<typeof updateNoteArgs>>;
type DeleteNoteArgs = z.infer<z.ZodObject<typeof deleteNoteArgs>>;

// Notes are free-form admin-created records with per-identity access grants
// (no wildcards). With an agent-scoped key, list/get auto-filter to
// access-granted notes; create/update/delete cross the same access boundary —
// the agent writes its own notes, and admins grant visibility to others.
export function noteTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_notes",
      group: "notes",
      defaultEnabled: true,
      definition: {
        description: "List notes this identity has access to. Optional free-text search via `q`.",
        args: listNotesArgs,
        async execute(args: ListNotesArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const notes = await inkbox.notes.list({
              q: args.q,
              order: args.order,
              limit: args.limit ?? 50,
            });
            return formatWithHeader(`Returned ${notes.length} note(s).`, notes);
          });
        },
      },
    },
    {
      name: "inkbox_get_note",
      group: "notes",
      defaultEnabled: true,
      definition: {
        description: "Fetch a single note by UUID.",
        args: getNoteArgs,
        async execute(args: GetNoteArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const note = await inkbox.notes.get(args.noteId);
            return formatJson(note);
          });
        },
      },
    },
    {
      name: "inkbox_create_note",
      group: "notes",
      defaultEnabled: true,
      definition: {
        description:
          "Create a new note. The body is required; title is optional. Visibility follows per-identity access grants set in the Inkbox Console.",
        args: createNoteArgs,
        async execute(args: CreateNoteArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const note = await inkbox.notes.create({
              body: args.body,
              title: args.title,
            });
            return {
              title: `Created note ${note.id}`,
              output: `Created note id=${note.id}.`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_update_note",
      group: "notes",
      defaultEnabled: false,
      definition: {
        description:
          "Update a note's title or body. Pass title=null to clear the title (body cannot be cleared).",
        args: updateNoteArgs,
        async execute(args: UpdateNoteArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            // The update is a JSON merge patch: `title` must only appear when
            // explicitly provided (null clears it), so build the payload
            // field by field instead of forwarding args wholesale.
            const updates: { title?: string | null; body?: string } = {};
            if (args.title !== undefined) updates.title = args.title;
            if (args.body !== undefined) updates.body = args.body;
            await inkbox.notes.update(args.noteId, updates);
            return {
              title: `Updated note ${args.noteId}`,
              output: `Updated note ${args.noteId}.`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_delete_note",
      group: "notes",
      defaultEnabled: false,
      definition: {
        description: "Delete a note by UUID. Irreversible.",
        args: deleteNoteArgs,
        async execute(args: DeleteNoteArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            await inkbox.notes.delete(args.noteId);
            return {
              title: `Deleted note ${args.noteId}`,
              output: `Deleted note ${args.noteId}.`,
            };
          });
        },
      },
    },
  ];
}
