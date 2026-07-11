import {
  IMessageRuleAction,
  IMessageRuleMatchType,
  MailRuleAction,
  MailRuleMatchType,
  PhoneRuleAction,
  PhoneRuleMatchType,
} from "@inkbox/sdk";
import { z } from "zod";
import { runTool } from "../errors.js";
import { formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const mailRuleActionSchema = z.enum(MailRuleAction);
const mailRuleMatchTypeSchema = z.enum(MailRuleMatchType);
const phoneRuleActionSchema = z.enum(PhoneRuleAction);
const phoneRuleMatchTypeSchema = z.enum(PhoneRuleMatchType);
const imessageRuleActionSchema = z.enum(IMessageRuleAction);
const imessageRuleMatchTypeSchema = z.enum(IMessageRuleMatchType);

const listMailContactRulesArgs = {
  action: mailRuleActionSchema.optional(),
  matchType: mailRuleMatchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const listPhoneContactRulesArgs = {
  action: phoneRuleActionSchema.optional(),
  matchType: phoneRuleMatchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const listIMessageContactRulesArgs = {
  action: imessageRuleActionSchema.optional(),
  matchType: imessageRuleMatchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

type ListMailContactRulesArgs = z.infer<z.ZodObject<typeof listMailContactRulesArgs>>;
type ListPhoneContactRulesArgs = z.infer<z.ZodObject<typeof listPhoneContactRulesArgs>>;
type ListIMessageContactRulesArgs = z.infer<z.ZodObject<typeof listIMessageContactRulesArgs>>;

// Allow/block rules filtering the identity's inbound email, phone, and
// iMessage traffic — read-only by design: the API only lets agent-scoped
// keys VIEW rules (writes are admin/console-only), so the agent can always
// see its own inbound authorization but never change it.
export function contactRuleTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_mail_contact_rules",
      group: "contact-rules",
      defaultEnabled: true,
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
      name: "inkbox_list_phone_contact_rules",
      group: "contact-rules",
      defaultEnabled: true,
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
      name: "inkbox_list_imessage_contact_rules",
      group: "contact-rules",
      defaultEnabled: true,
      definition: {
        description:
          "List allow/block rules for the configured Inkbox identity's shared iMessage line. Rules affect who can reach the agent over iMessage.",
        args: listIMessageContactRulesArgs,
        async execute(args: ListIMessageContactRulesArgs, _ctx) {
          return runTool(async () => {
            // No iMessage guard: the API returns [] when the line is off.
            const client = await runtime.getClient();
            const identity = await runtime.getIdentity();
            const rules = await client.imessageContactRules.list(identity.agentHandle, {
              action: args.action,
              matchType: args.matchType,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${rules.length} iMessage rule(s).`, rules);
          });
        },
      },
    },
  ];
}
