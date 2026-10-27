import type { AgentPermissionRequest, AgentPermissionResponse } from "../../../agent-sdk-types.js";
import type {
  PiExtension,
  PiExtensionDialog,
  PiExtensionSession,
  PiExtensionToolCall,
} from "./contract.js";

const PREFIX = "pi-questionnaire:";
const OTHER_LABEL = "Other (write an answer)";
const TERMINAL_CHOICE = "Answer in terminal";
const CANCEL_CHOICE = "Cancel questionnaire";
interface Option {
  value: string;
  label: string;
  description?: string;
}
interface Question {
  id: string;
  label?: string;
  prompt: string;
  allowOther?: boolean;
  options: Option[];
}
interface FrameMetadata {
  v: 1;
  toolCallId: string;
  index: number;
  input: boolean;
}
interface Active {
  callId: string;
  provider: string;
  questions: Question[];
  headers: string[];
  formAnswers: Record<string, unknown> | null;
  deferred: PiExtensionDialog | null;
  index: number;
  awaitingCustom: boolean;
  cancelled: boolean;
  concurrent: boolean;
  batchCreated: boolean;
  inputAvailable: boolean | null;
  pendingInput?: { requestId: string; dialog: PiExtensionDialog; header: string };
}

function isQuestionnaireArgs(args: unknown): Question[] | undefined {
  if (!args || typeof args !== "object") return undefined;
  const questions = Reflect.get(args, "questions") as unknown;
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.some((q: unknown) => {
      if (!q || typeof q !== "object") return true;
      const id = Reflect.get(q, "id");
      const label = Reflect.get(q, "label");
      const prompt = Reflect.get(q, "prompt");
      const allowOther = Reflect.get(q, "allowOther");
      const options = Reflect.get(q, "options");
      return (
        typeof id !== "string" ||
        (label !== undefined && typeof label !== "string") ||
        typeof prompt !== "string" ||
        (allowOther !== undefined && typeof allowOther !== "boolean") ||
        !Array.isArray(options) ||
        options.some((option: unknown) => {
          if (!option || typeof option !== "object") return true;
          const value = Reflect.get(option, "value");
          const optionLabel = Reflect.get(option, "label");
          const description = Reflect.get(option, "description");
          return (
            typeof value !== "string" ||
            typeof optionLabel !== "string" ||
            (description !== undefined && typeof description !== "string")
          );
        })
      );
    })
  )
    return undefined;
  return questions as Question[];
}

function questionTitle(question: Question, index: number, total: number): string {
  const label = question.label || `Q${index + 1}`;
  const lines = [
    total === 1 ? `Question · ${label}` : `Question ${index + 1} of ${total} · ${label}`,
    "",
    question.prompt,
  ];
  if (question.options.some((option) => option.description)) {
    lines.push("", "Options:");
    question.options.forEach((option, optionIndex) => {
      lines.push(`${optionIndex + 1}. ${option.label}`);
      if (option.description) lines.push(`   ${option.description}`);
    });
  }
  return lines.join("\n");
}

function expectedSelectOptions(question: Question, inputAvailable: boolean): string[] {
  return [
    ...question.options.map((option, index) => `${index + 1}. ${option.label}`),
    ...(inputAvailable && question.allowOther !== false ? [OTHER_LABEL] : []),
    TERMINAL_CHOICE,
    CANCEL_CHOICE,
  ];
}

function frameMetadata(dialog: PiExtensionDialog): FrameMetadata | undefined {
  const raw = Reflect.get(dialog, "paseoQuestionnaire") as unknown;
  if (!raw || typeof raw !== "object") return undefined;
  const v = Reflect.get(raw, "v");
  const toolCallId = Reflect.get(raw, "toolCallId");
  const index = Reflect.get(raw, "index");
  const input = Reflect.get(raw, "input");
  return v === 1 &&
    typeof toolCallId === "string" &&
    Number.isInteger(index) &&
    typeof input === "boolean"
    ? { v, toolCallId, index, input }
    : undefined;
}

export const piQuestionnaire: PiExtension = {
  id: "pi-native-questionnaire",
  createSession(): PiExtensionSession {
    let active: Active | undefined;

    function terminalOptions(dialog: PiExtensionDialog): string[] {
      return "options" in dialog && Array.isArray(dialog.options) ? dialog.options : [];
    }

    function hasMatchingFrame(dialog: PiExtensionDialog, input: boolean): boolean {
      if (!active) return false;
      const metadata = frameMetadata(dialog);
      return Boolean(
        metadata &&
        metadata.toolCallId === active.callId &&
        metadata.index === active.index &&
        metadata.input === input &&
        (active.inputAvailable === null || active.inputAvailable === metadata.input),
      );
    }

    function matchesSelect(dialog: PiExtensionDialog): boolean {
      if (!active || dialog.method !== "select") return false;
      const metadata = frameMetadata(dialog);
      const question = active.questions[active.index];
      if (
        !metadata ||
        metadata.toolCallId !== active.callId ||
        metadata.index !== active.index ||
        !question ||
        !("title" in dialog) ||
        dialog.title !== questionTitle(question, active.index, active.questions.length)
      )
        return false;
      if (active.inputAvailable !== null && metadata.input !== active.inputAvailable) return false;
      const options = terminalOptions(dialog);
      const expected = expectedSelectOptions(question, metadata.input);
      return (
        options.length === expected.length &&
        options.every((option, index) => option === expected[index])
      );
    }

    function matchesCustomInput(dialog: PiExtensionDialog): boolean {
      if (
        !active ||
        dialog.method !== "input" ||
        !active.awaitingCustom ||
        !hasMatchingFrame(dialog, true)
      )
        return false;
      const question = active.questions[active.index];
      return Boolean(
        question &&
        "title" in dialog &&
        dialog.title === questionTitle(question, active.index, active.questions.length) &&
        "placeholder" in dialog &&
        dialog.placeholder === "Type your answer",
      );
    }

    function validBatchAnswers(answers: unknown): answers is Record<string, unknown> {
      const state = active;
      if (
        !state ||
        state.inputAvailable === null ||
        !answers ||
        typeof answers !== "object" ||
        Array.isArray(answers)
      )
        return false;
      const record = answers as Record<string, unknown>;
      if (Object.keys(record).length !== state.questions.length) return false;
      const headers = state.headers;
      const inputAvailable = state.inputAvailable;
      return state.questions.every((question, index) => {
        const value = record[headers[index]];
        const choices = [
          ...question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}`),
          ...(inputAvailable && question.allowOther !== false
            ? [`${question.options.length + 1}. ${OTHER_LABEL}`]
            : []),
        ];
        return typeof value === "string" && choices.includes(value);
      });
    }

    function batchPermission(inputAvailable: boolean): AgentPermissionRequest {
      if (!active) throw new Error("Questionnaire tool is no longer active");
      return {
        id: `${PREFIX}${active.callId}`,
        provider: active.provider,
        name: "Pi questionnaire",
        kind: "question",
        title:
          active.questions.length === 1
            ? active.questions[0].prompt
            : `${active.questions.length} questions`,
        input: {
          questions: active.questions.map((question, index) => ({
            question: question.prompt,
            header: active?.headers[index] ?? `${index + 1}. Q${index + 1} · ${question.id}`,
            options: [
              ...question.options.map((option, optionIndex) => ({
                label: `${optionIndex + 1}. ${option.label}`,
                ...(option.description ? { description: option.description } : {}),
              })),
              ...(inputAvailable && question.allowOther !== false
                ? [{ label: `${question.options.length + 1}. ${OTHER_LABEL}` }]
                : []),
            ],
            multiSelect: false,
            allowOther: false,
          })),
        },
      };
    }

    function replyToSelect(dialog: PiExtensionDialog) {
      if (!active || active.cancelled || !active.formAnswers) return { cancelled: true };
      const question = active.questions[active.index];
      if (!question) return { cancelled: true };
      const answer = active.formAnswers[active.headers[active.index]];
      if (typeof answer !== "string") return { cancelled: true };
      const projected = question.options.map((option, index) => `${index + 1}. ${option.label}`);
      const selectedIndex = projected.indexOf(answer);
      const options = terminalOptions(dialog);
      if (selectedIndex >= 0) {
        if (options[selectedIndex] !== projected[selectedIndex]) return { cancelled: true };
        active.index++;
        return { value: options[selectedIndex] };
      }
      if (
        active.inputAvailable &&
        question.allowOther !== false &&
        answer === `${question.options.length + 1}. ${OTHER_LABEL}`
      ) {
        const otherIndex = question.options.length;
        const other = options[otherIndex];
        if (other !== OTHER_LABEL) return { cancelled: true };
        active.awaitingCustom = true;
        return { value: other };
      }
      return { cancelled: true };
    }

    function inputPermission(dialog: PiExtensionDialog): AgentPermissionRequest {
      if (!active) throw new Error("Questionnaire tool is no longer active");
      const requestId = `${PREFIX}${active.callId}:input:${dialog.id}`;
      const header = `custom.${active.index + 1}.${active.questions[active.index]?.id ?? "answer"}`;
      active.pendingInput = { requestId, dialog, header };
      const title =
        "title" in dialog && typeof dialog.title === "string" ? dialog.title : "Type your answer";
      const placeholder =
        "placeholder" in dialog && typeof dialog.placeholder === "string" ? dialog.placeholder : "";
      return {
        id: requestId,
        provider: active.provider,
        name: "Pi questionnaire answer",
        kind: "question",
        title,
        input: {
          questions: [
            {
              question: title,
              header,
              options: [],
              multiSelect: false,
              allowOther: false,
              allowEmpty: true,
              ...(placeholder ? { placeholder } : {}),
            },
          ],
        },
      };
    }

    return {
      onToolStart(call: PiExtensionToolCall, provider: string): AgentPermissionRequest | undefined {
        if (call.toolName !== "questionnaire") return undefined;
        if (active) {
          active.concurrent = true;
          active.cancelled = true;
          return undefined;
        }
        const questions = isQuestionnaireArgs(call.args);
        if (!questions) return undefined;
        const headers = questions.map(
          (question, index) =>
            `${index + 1}. ${question.label || `Q${index + 1}`} · ${question.id}`,
        );
        active = {
          callId: call.callId,
          provider,
          questions,
          headers,
          formAnswers: null,
          deferred: null,
          index: 0,
          awaitingCustom: false,
          cancelled: false,
          concurrent: false,
          batchCreated: false,
          inputAvailable: null,
        };
        return undefined;
      },
      onToolEnd(call: PiExtensionToolCall) {
        if (active?.callId === call.callId) active = undefined;
      },
      mapDialog(dialog: PiExtensionDialog, _provider: string) {
        if (!active) return undefined;
        if (dialog.method === "select") {
          if (!matchesSelect(dialog)) return undefined;
          const metadata = frameMetadata(dialog);
          if (!metadata) return undefined;
          if (active.cancelled) return { type: "response" as const, response: { cancelled: true } };
          if (!active.batchCreated) {
            active.batchCreated = true;
            active.inputAvailable = metadata.input;
            active.deferred = dialog;
            return {
              type: "permission" as const,
              request: batchPermission(metadata.input),
              toolCallId: active.callId,
            };
          }
          if (!active.formAnswers) {
            return active.deferred?.id === dialog.id
              ? {
                  type: "deferred" as const,
                  requestId: `${PREFIX}${active.callId}`,
                  toolCallId: active.callId,
                }
              : undefined;
          }
          return { type: "response" as const, response: replyToSelect(dialog) };
        }
        if (dialog.method === "input") {
          if (!matchesCustomInput(dialog)) return undefined;
          if (active.cancelled) return { type: "response" as const, response: { cancelled: true } };
          return {
            type: "permission" as const,
            request: inputPermission(dialog),
            toolCallId: active.callId,
          };
        }
        return undefined;
      },
      respondToPermission(request: AgentPermissionRequest, response: AgentPermissionResponse) {
        if (!active) return undefined;
        if (active.concurrent) return { responses: [] };
        const input = active.pendingInput;
        if (input?.requestId === request.id) {
          active.pendingInput = undefined;
          if (response.behavior !== "allow") {
            active.cancelled = true;
            return { responses: [{ id: input.dialog.id, response: { cancelled: true } }] };
          }
          const answers = response.updatedInput?.answers;
          const value =
            answers && typeof answers === "object" && !Array.isArray(answers)
              ? Reflect.get(answers, input.header)
              : undefined;
          if (typeof value !== "string") {
            active.cancelled = true;
            return { responses: [{ id: input.dialog.id, response: { cancelled: true } }] };
          }
          active.awaitingCustom = false;
          active.index++;
          return { responses: [{ id: input.dialog.id, response: { value } }] };
        }
        if (request.id !== `${PREFIX}${active.callId}`) return undefined;
        const answers = response.behavior === "allow" ? response.updatedInput?.answers : undefined;
        active.formAnswers = validBatchAnswers(answers) ? answers : null;
        active.cancelled = response.behavior !== "allow" || !active.formAnswers;
        const deferred = active.deferred;
        active.deferred = null;
        return {
          responses: deferred ? [{ id: deferred.id, response: replyToSelect(deferred) }] : [],
        };
      },
    };
  },
};
