import {
  callModelWithValidation,
  type IAgentRuntime,
  ModelType,
  type ToolDefinition,
} from "@elizaos/core";

export const LIFE_MANAGER_SPECIALIST_DECISION =
  "LIFE_MANAGER_SPECIALIST_DECISION" as const;

export interface SpecialistCandidate {
  readonly candidateRef: string;
  readonly summary: string;
}

export interface SpecialistTool {
  readonly toolRef: string;
  readonly description: string;
}

export interface SpecialistDecisionRequest {
  readonly workItemRef: string;
  readonly objective: string;
  readonly candidates: readonly SpecialistCandidate[];
  readonly tools: readonly SpecialistTool[];
  readonly signal?: AbortSignal;
}

export interface SpecialistDecisionGraphNode {
  readonly id: string;
  readonly toolRef: string;
  readonly inputRefs: readonly string[];
}

export interface SpecialistDecisionGraph {
  readonly version: 1;
  readonly nodes: readonly SpecialistDecisionGraphNode[];
  readonly edges: readonly { from: string; to: string }[];
}

export interface SpecialistDecision {
  readonly candidateRef: string;
  readonly toolRef: string;
  readonly nextGraph: SpecialistDecisionGraph;
  readonly attempts: number;
}

const MAX_GRAPH_TEXT = 16_384;
const MAX_REF_LENGTH = 512;
const MAX_NODE_ID_LENGTH = 256;
const MAX_NODES = 64;
const MAX_EDGES = 128;
const MAX_INPUT_REFS = 64;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function invalidDecision(): never {
  throw new Error("Invalid Life Manager specialist decision");
}

function parseNextGraph(
  raw: string,
  candidateRefs: ReadonlySet<string>,
  toolRefs: ReadonlySet<string>,
): SpecialistDecisionGraph {
  if (!boundedString(raw, MAX_GRAPH_TEXT)) invalidDecision();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalidDecision();
  }

  const graph = record(parsed);
  if (
    !graph ||
    !exactKeys(graph, ["version", "nodes", "edges"]) ||
    graph.version !== 1 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    graph.nodes.length > MAX_NODES ||
    graph.edges.length > MAX_EDGES
  ) {
    invalidDecision();
  }

  const nodeIds = new Set<string>();
  const nodes = graph.nodes.map((value) => {
    const node = record(value);
    if (!node || !exactKeys(node, ["id", "toolRef", "inputRefs"]))
      invalidDecision();
    if (!boundedString(node.id, MAX_NODE_ID_LENGTH) || nodeIds.has(node.id)) {
      invalidDecision();
    }
    if (
      !boundedString(node.toolRef, MAX_REF_LENGTH) ||
      !toolRefs.has(node.toolRef)
    ) {
      invalidDecision();
    }
    if (
      !Array.isArray(node.inputRefs) ||
      node.inputRefs.length > MAX_INPUT_REFS
    ) {
      invalidDecision();
    }
    const inputRefs = node.inputRefs.map((ref) => {
      if (
        !boundedString(ref, MAX_REF_LENGTH) ||
        (!candidateRefs.has(ref) && !toolRefs.has(ref))
      ) {
        invalidDecision();
      }
      return ref;
    });
    nodeIds.add(node.id);
    return { id: node.id, toolRef: node.toolRef, inputRefs };
  });

  const edges = graph.edges.map((value) => {
    const edge = record(value);
    if (!edge || !exactKeys(edge, ["from", "to"])) invalidDecision();
    if (
      !boundedString(edge.from, MAX_NODE_ID_LENGTH) ||
      !boundedString(edge.to, MAX_NODE_ID_LENGTH) ||
      !nodeIds.has(edge.from) ||
      !nodeIds.has(edge.to)
    ) {
      invalidDecision();
    }
    return { from: edge.from, to: edge.to };
  });

  return { version: 1, nodes, edges };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function decideSpecialistStep(
  runtime: IAgentRuntime,
  request: SpecialistDecisionRequest,
): Promise<SpecialistDecision> {
  const candidateRefs = request.candidates.map(
    ({ candidateRef }) => candidateRef,
  );
  const toolRefs = request.tools.map(({ toolRef }) => toolRef);
  const parameters = {
    type: "object" as const,
    additionalProperties: false,
    required: ["candidateRef", "toolRef", "nextGraph"],
    properties: {
      candidateRef: { type: "string" as const, enum: candidateRefs },
      toolRef: { type: "string" as const, enum: toolRefs },
      nextGraph: { type: "string" as const, maxLength: MAX_GRAPH_TEXT },
    },
  };
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["action", "params"],
    properties: {
      action: {
        type: "string" as const,
        enum: [LIFE_MANAGER_SPECIALIST_DECISION],
      },
      params: parameters,
    },
  };
  const decisionTool: ToolDefinition = {
    name: LIFE_MANAGER_SPECIALIST_DECISION,
    description:
      "Choose the next bounded Life Manager step from the offered candidates and tools. Return one candidate, one tool, and a reference-only graph; do not invent references or perform work.",
    parameters,
    strict: true,
  };
  const prompt = [
    "Choose exactly one next Life Manager step.",
    "Use only the offered references. Return the required decision envelope and a reference-only nextGraph.",
    "Do not invent references, credentials, or other fields, and do not perform any operation.",
    `Work item: ${request.workItemRef}`,
    `Objective: ${request.objective}`,
    `Candidates: ${JSON.stringify(request.candidates)}`,
    `Tools: ${JSON.stringify(request.tools)}`,
  ].join("\n");

  const result = await callModelWithValidation(runtime, {
    modelType: ModelType.ACTION_PLANNER,
    params: {
      prompt,
      messages: [{ role: "user", content: prompt }],
      tools: [decisionTool],
      toolChoice: "required",
      responseFormat: { type: "json_object" },
      responseSchema: schema,
      voiceOutput: "internal",
      signal: request.signal,
    },
    schema,
    maxRerolls: 1,
    validateBeforeReturn: true,
  });

  const envelope = result.parsed;
  const params = record(envelope.params);
  if (
    envelope.action !== LIFE_MANAGER_SPECIALIST_DECISION ||
    !params ||
    !exactKeys(params, ["candidateRef", "toolRef", "nextGraph"]) ||
    !boundedString(params.candidateRef, MAX_REF_LENGTH) ||
    !boundedString(params.toolRef, MAX_REF_LENGTH) ||
    !candidateRefs.includes(params.candidateRef) ||
    !toolRefs.includes(params.toolRef) ||
    typeof params.nextGraph !== "string"
  ) {
    invalidDecision();
  }

  const nextGraph = parseNextGraph(
    params.nextGraph,
    new Set(candidateRefs),
    new Set(toolRefs),
  );
  return deepFreeze({
    candidateRef: params.candidateRef,
    toolRef: params.toolRef,
    nextGraph,
    attempts: result.attempts,
  });
}
