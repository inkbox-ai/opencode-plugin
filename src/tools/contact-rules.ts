import {
  ContactRuleStatus,
  MailRuleAction,
  MailRuleMatchType,
  PhoneRuleAction,
  PhoneRuleMatchType,
} from "@inkbox/sdk";
import { z } from "zod";
import type { InkboxRuntime } from "../client.js";
import { runTool } from "../errors.js";
import { formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

// Wrap the SDK enums so parsed args are typed as the enums the SDK expects
// ("allow" | "block", "exact_email" | "domain", "exact_number", etc.).
const ruleStatusSchema = z.enum(ContactRuleStatus);
const mailRuleActionSchema = z.enum(MailRuleAction);
const mailRuleMatchTypeSchema = z.enum(MailRuleMatchType);
const phoneRuleActionSchema = z.enum(PhoneRuleAction);
const phoneRuleMatchTypeSchema = z.enum(PhoneRuleMatchType);

const listMailContactRulesArgs = {
  action: mailRuleActionSchema.optional(),
  matchType: mailRuleMatchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const createMailContactRuleArgs = {
  action: mailRuleActionSchema,
  matchType: mailRuleMatchTypeSchema,
  matchTarget: z
    .string()
    .min(1)
    .describe("Email address for exact_email or bare domain for domain."),
};

const updateMailContactRuleArgs = {
  ruleId: z.string().describe("Mail contact rule UUID."),
  action: mailRuleActionSchema.optional(),
  status: ruleStatusSchema.optional(),
};

const deleteMailContactRuleArgs = {
  ruleId: z.string().describe("Mail contact rule UUID."),
};

const listPhoneContactRulesArgs = {
  action: phoneRuleActionSchema.optional(),
  matchType: phoneRuleMatchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const createPhoneContactRuleArgs = {
  action: phoneRuleActionSchema,
  matchType: phoneRuleMatchTypeSchema.optional(),
  matchTarget: z.string().min(1).describe("E.164 phone number, e.g. +15551234567."),
};

const updatePhoneContactRuleArgs = {
  ruleId: z.string().describe("Phone contact rule UUID."),
  action: phoneRuleActionSchema.optional(),
  status: ruleStatusSchema.optional(),
};

const deletePhoneContactRuleArgs = {
  ruleId: z.string().describe("Phone contact rule UUID."),
};

type ListMailContactRulesArgs = z.infer<z.ZodObject<typeof listMailContactRulesArgs>>;
type CreateMailContactRuleArgs = z.infer<z.ZodObject<typeof createMailContactRuleArgs>>;
type UpdateMailContactRuleArgs = z.infer<z.ZodObject<typeof updateMailContactRuleArgs>>;
type DeleteMailContactRuleArgs = z.infer<z.ZodObject<typeof deleteMailContactRuleArgs>>;
type ListPhoneContactRulesArgs = z.infer<z.ZodObject<typeof listPhoneContactRulesArgs>>;
type CreatePhoneContactRuleArgs = z.infer<z.ZodObject<typeof createPhoneContactRuleArgs>>;
type UpdatePhoneContactRuleArgs = z.infer<z.ZodObject<typeof updatePhoneContactRuleArgs>>;
type DeletePhoneContactRuleArgs = z.infer<z.ZodObject<typeof deletePhoneContactRuleArgs>>;

// Phone rule create/update/delete require the identity to have a number
// (voice + SMS share one rule set); list is graceful for phoneless
// identities, so only the mutating tools use this guard.
async function requirePhoneIdentity(runtime: InkboxRuntime) {
  const identity = await runtime.getIdentity();
  if (!identity.phoneNumber) {
    throw new Error(
      "This Inkbox identity has no phone number, so phone contact rules are unavailable.",
    );
  }
  return identity;
}

// Allow/block rules filtering the identity's inbound email and phone
// traffic, keyed by the agent identity. All opt-in: rule management is an
// admin-flavored surface most sessions never need.
export function contactRuleTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_mail_contact_rules",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "List allow/block rules for the configured Inkbox identity's mailbox. Use before changing email sender allowlists or blocklists.",
        args: listMailContactRulesArgs,
        async execute(args: ListMailContactRulesArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const rules = await identity.listMailContactRules({
              action: args.action,
              matchType: args.matchType,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${rules.length} mail rule(s).`, rules);
          });
        },
      },
    },
    {
      name: "inkbox_create_mail_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "Create a mailbox allow/block rule for one sender email address or domain. Use when the user asks to block or allow inbound email senders.",
        args: createMailContactRuleArgs,
        async execute(args: CreateMailContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const rule = await identity.createMailContactRule({
              action: args.action,
              matchType: args.matchType,
              matchTarget: args.matchTarget,
            });
            return {
              title: `Created mail contact rule ${rule.id}`,
              output: formatWithHeader(`Created mail contact rule id=${rule.id}.`, rule),
            };
          });
        },
      },
    },
    {
      name: "inkbox_update_mail_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "Update a mailbox contact rule's action or status. Use status=paused to temporarily disable a rule without deleting it.",
        args: updateMailContactRuleArgs,
        async execute(args: UpdateMailContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const rule = await identity.updateMailContactRule(args.ruleId, {
              action: args.action,
              status: args.status,
            });
            return {
              title: `Updated mail contact rule ${rule.id}`,
              output: formatWithHeader(`Updated mail contact rule id=${rule.id}.`, rule),
            };
          });
        },
      },
    },
    {
      name: "inkbox_delete_mail_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description: "Delete a mailbox contact rule by UUID.",
        args: deleteMailContactRuleArgs,
        async execute(args: DeleteMailContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            await identity.deleteMailContactRule(args.ruleId);
            return {
              title: `Deleted mail contact rule ${args.ruleId}`,
              output: `Deleted mail contact rule ${args.ruleId}.`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_list_phone_contact_rules",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "List allow/block rules for the configured Inkbox identity's phone number. Rules affect inbound SMS and calls.",
        args: listPhoneContactRulesArgs,
        async execute(args: ListPhoneContactRulesArgs, _ctx) {
          return runTool(async () => {
            // No phone guard: the API returns [] for a phoneless identity.
            const identity = await runtime.getIdentity();
            const rules = await identity.listPhoneContactRules({
              action: args.action,
              matchType: args.matchType,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${rules.length} phone rule(s).`, rules);
          });
        },
      },
    },
    {
      name: "inkbox_create_phone_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "Create a phone-number allow/block rule for an E.164 number. Use when the user asks to block or allow inbound SMS/calls.",
        args: createPhoneContactRuleArgs,
        async execute(args: CreatePhoneContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await requirePhoneIdentity(runtime);
            const rule = await identity.createPhoneContactRule({
              action: args.action,
              matchType: args.matchType,
              matchTarget: args.matchTarget,
            });
            return {
              title: `Created phone contact rule ${rule.id}`,
              output: formatWithHeader(`Created phone contact rule id=${rule.id}.`, rule),
            };
          });
        },
      },
    },
    {
      name: "inkbox_update_phone_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description:
          "Update a phone contact rule's action or status. Use status=paused to temporarily disable a rule without deleting it.",
        args: updatePhoneContactRuleArgs,
        async execute(args: UpdatePhoneContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await requirePhoneIdentity(runtime);
            const rule = await identity.updatePhoneContactRule(args.ruleId, {
              action: args.action,
              status: args.status,
            });
            return {
              title: `Updated phone contact rule ${rule.id}`,
              output: formatWithHeader(`Updated phone contact rule id=${rule.id}.`, rule),
            };
          });
        },
      },
    },
    {
      name: "inkbox_delete_phone_contact_rule",
      group: "contact-rules",
      defaultEnabled: false,
      definition: {
        description: "Delete a phone contact rule by UUID.",
        args: deletePhoneContactRuleArgs,
        async execute(args: DeletePhoneContactRuleArgs, _ctx) {
          return runTool(async () => {
            const identity = await requirePhoneIdentity(runtime);
            await identity.deletePhoneContactRule(args.ruleId);
            return {
              title: `Deleted phone contact rule ${args.ruleId}`,
              output: `Deleted phone contact rule ${args.ruleId}.`,
            };
          });
        },
      },
    },
  ];
}
