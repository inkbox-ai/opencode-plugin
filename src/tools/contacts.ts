import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const contactEmailSchema = z.object({
  value: z.string().describe("Email address."),
  label: z.string().describe("Optional label, e.g. work/home.").optional(),
  isPrimary: z.boolean().describe("Whether this is the primary email.").optional(),
});

const contactPhoneSchema = z.object({
  value: z.string().describe("E.164 phone number, e.g. +15551234567."),
  label: z.string().describe("Optional label, e.g. mobile/work.").optional(),
  isPrimary: z.boolean().describe("Whether this is the primary phone.").optional(),
});

const lookupContactArgs = {
  email: z.string().describe("Exact email address.").optional(),
  phone: z.string().describe("Exact E.164 phone number.").optional(),
  emailDomain: z.string().describe("Match by email domain (e.g. 'example.com').").optional(),
  emailContains: z.string().describe("Substring match on email address.").optional(),
  phoneContains: z.string().describe("Substring match on phone number.").optional(),
};

const getContactArgs = {
  contactId: z.string().describe("UUID of the contact."),
};

const listContactsArgs = {
  q: z.string().describe("Free-text search across names/emails/phones.").optional(),
  order: z.enum(["recent", "name"]).describe("Sort order. Defaults to recent.").optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const createContactArgs = {
  preferredName: z.string().describe("Display/preferred name.").optional(),
  givenName: z.string().describe("Given/first name.").optional(),
  familyName: z.string().describe("Family/last name.").optional(),
  companyName: z.string().describe("Company or organization.").optional(),
  jobTitle: z.string().describe("Job title.").optional(),
  notes: z.string().describe("Free-form contact notes.").optional(),
  emails: z.array(contactEmailSchema).describe("Email addresses.").optional(),
  phones: z.array(contactPhoneSchema).describe("Phone numbers.").optional(),
};

const updateContactArgs = {
  contactId: z.string().describe("UUID of the contact to update."),
  preferredName: z.string().nullable().optional(),
  givenName: z.string().nullable().optional(),
  familyName: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  emails: z.array(contactEmailSchema).nullable().optional(),
  phones: z.array(contactPhoneSchema).nullable().optional(),
};

const deleteContactArgs = {
  contactId: z.string().describe("UUID of the contact to delete."),
};

type LookupContactArgs = z.infer<z.ZodObject<typeof lookupContactArgs>>;
type GetContactArgs = z.infer<z.ZodObject<typeof getContactArgs>>;
type ListContactsArgs = z.infer<z.ZodObject<typeof listContactsArgs>>;
type CreateContactArgs = z.infer<z.ZodObject<typeof createContactArgs>>;
type UpdateContactArgs = z.infer<z.ZodObject<typeof updateContactArgs>>;
type DeleteContactArgs = z.infer<z.ZodObject<typeof deleteContactArgs>>;

type ContactEmailInput = z.infer<typeof contactEmailSchema>;
type ContactPhoneInput = z.infer<typeof contactPhoneSchema>;

// Shared shape of the writable contact fields on create/update. Nulls only
// occur on update, where they clear a field server-side.
interface ContactWriteArgs {
  preferredName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  notes?: string | null;
  emails?: ContactEmailInput[] | null;
  phones?: ContactPhoneInput[] | null;
}

const contactScalarKeys = [
  "preferredName",
  "givenName",
  "familyName",
  "companyName",
  "jobTitle",
  "notes",
] as const;

// The SDK's ContactEmail/ContactPhone require explicit label/isPrimary.
function normalizeContactEmails(emails: ContactEmailInput[]) {
  return emails.map((entry) => ({
    value: entry.value,
    label: entry.label ?? null,
    isPrimary: Boolean(entry.isPrimary),
  }));
}

function normalizeContactPhones(phones: ContactPhoneInput[]) {
  return phones.map((entry) => ({
    value: entry.value,
    label: entry.label ?? null,
    isPrimary: Boolean(entry.isPrimary),
  }));
}

// Copies only the fields present in args so PATCH semantics hold: an omitted
// field stays untouched, an explicit null clears it.
function buildContactWritePayload(args: ContactWriteArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of contactScalarKeys) {
    if (args[key] !== undefined) {
      payload[key] = args[key];
    }
  }
  if (args.emails !== undefined) {
    payload.emails = args.emails === null ? null : normalizeContactEmails(args.emails);
  }
  if (args.phones !== undefined) {
    payload.phones = args.phones === null ? null : normalizeContactPhones(args.phones);
  }
  return payload;
}

// Contacts are shared across every identity in the organization.
export function contactTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_lookup_contact",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description:
          "Reverse-lookup organization contacts by email or phone. Exactly one filter must be provided — email, phone, emailDomain, emailContains, or phoneContains.",
        args: lookupContactArgs,
        async execute(args: LookupContactArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const results = await inkbox.contacts.lookup(args);
            return formatWithHeader(`Found ${results.length} contact(s).`, results);
          });
        },
      },
    },
    {
      name: "inkbox_get_contact",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch a single contact by UUID. Returns the full contact record, including names, emails, phones, company, and notes.",
        args: getContactArgs,
        async execute(args: GetContactArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const contact = await inkbox.contacts.get(args.contactId);
            return formatJson(contact);
          });
        },
      },
    },
    {
      name: "inkbox_list_contacts",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description: "List organization-wide contacts. Optional free-text search via `q`.",
        args: listContactsArgs,
        async execute(args: ListContactsArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const contacts = await inkbox.contacts.list({
              q: args.q,
              order: args.order,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${contacts.length} contact(s).`, contacts);
          });
        },
      },
    },
    {
      name: "inkbox_create_contact",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description:
          "Create an organization-wide Inkbox address-book contact. Use when the user asks to save a person/contact in Inkbox. Include phone/email when known; notes can hold free-form context.",
        args: createContactArgs,
        async execute(args: CreateContactArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const contact = await inkbox.contacts.create(buildContactWritePayload(args) as any);
            return {
              title: `Created contact ${contact.id}`,
              output: formatWithHeader(`Created contact id=${contact.id}.`, contact),
            };
          });
        },
      },
    },
    {
      name: "inkbox_update_contact",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description:
          "Update an organization-wide Inkbox address-book contact by UUID. Use after lookup/get when the user asks to add or correct contact details.",
        args: updateContactArgs,
        async execute(args: UpdateContactArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            const payload = buildContactWritePayload(args);
            const contact = await inkbox.contacts.update(args.contactId, payload as any);
            return {
              title: `Updated contact ${contact.id}`,
              output: formatWithHeader(`Updated contact id=${contact.id}.`, contact),
            };
          });
        },
      },
    },
    {
      name: "inkbox_delete_contact",
      group: "contacts",
      defaultEnabled: true,
      definition: {
        description:
          "Delete an organization-wide Inkbox address-book contact by UUID. Irreversible.",
        args: deleteContactArgs,
        async execute(args: DeleteContactArgs, _ctx) {
          return runTool(async () => {
            const inkbox = await runtime.getClient();
            await inkbox.contacts.delete(args.contactId);
            return {
              title: `Deleted contact ${args.contactId}`,
              output: `Deleted contact ${args.contactId}.`,
            };
          });
        },
      },
    },
  ];
}
